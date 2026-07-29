/**
 * claude-to-rollout.mjs — convert a Claude Code session transcript (JSONL) into
 * a Codex rollout (JSONL) that `codex resume <id>` can load and render.
 *
 * This is a CROSS-AGENT HANDOFF, not a replay:
 *   - user / assistant TEXT messages are preserved as Codex response_item messages
 *   - tool_use / tool_result are NOT mapped to Codex function_call (foreign tool
 *     records crash Codex's loader via an exhaustive-switch); each tool call
 *     becomes a one-line `[bridged tool call: <name> <arg>]` footnote on its
 *     assistant turn. The receiving model understands what was done but can't
 *     undo/re-execute it.
 *
 * Output shape mirrors a real Codex rollout (see lib/agents/codex.mjs header):
 * each line is {timestamp, type, payload} with type in
 * {session_meta, event_msg, response_item, turn_context}. A session needs the
 * full per-turn envelope (task_started → turn_context → user msg + echo →
 * assistant msg + echo → task_complete) to RENDER — bare response_items load
 * but display empty. See memory `codex-rollout-cross-agent-handoff`.
 *
 * Pure: no fs / env / sqlite. Environment-derived values (cwd, model, now) come
 * via `opts` so the converter is unit-testable; the caller (MCP handler) reads
 * config + process.cwd() and passes them in.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Reduce a (possibly MCP-qualified) tool name to its short tail. */
function shortToolName(name) {
  return String(name || 'tool').split('__').pop();
}

/** Turn a tool_use input into a brief arg hint for the prose footnote. */
function formatToolArg(input) {
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  if (!keys.length) return '';
  const v = input[keys[0]];
  if (typeof v === 'string') return ` ${v.slice(0, 80)}`;
  if (Array.isArray(v)) return ` [${v.length} items]`;
  return ` <${keys[0]}>`;
}

/**
 * Strip Claude slash-command wrapper blocks (<command-message>, <command-name>,
 * <command-args>, <local-command-*>) from a user message. Returns '' when the
 * message was only command chrome (so the caller can skip it as a turn).
 */
function stripCommandChrome(text) {
  return String(text || '')
    .replace(/<command-\w+>[^]*?<\/command-\w+>\s*/g, '')
    .replace(/<local-command-\w+>[^]*?<\/local-command-\w+>\s*/g, '')
    .trim();
}

/**
 * Convert a Claude Code transcript into a Codex rollout.
 *
 * @param {string} claudeJsonl - Raw Claude session JSONL (one object per line).
 * @param {object} [opts]
 * @param {string} [opts.sessionId]     - UUID for the new Codex session (session_meta
 *        + the restore filename + threads row). Caller should pass the same id it
 *        uses for `resolveCodexRestorePath` so the filename matches.
 * @param {string} [opts.cwd]           - Working dir recorded in the rollout.
 * @param {string} [opts.model]         - Codex model name (e.g. 'gpt-5.4').
 * @param {string} [opts.modelProvider] - e.g. 'openai'.
 * @param {string} [opts.timezone]      - e.g. 'Asia/Shanghai'.
 * @param {Date}   [opts.now]           - Timestamps (injectable for tests).
 * @param {string} [opts.cliVersion]
 * @param {string} [opts.baseInstructions]
 * @returns {{ rollout: string, title: string }} `rollout` is NDJSON (lines joined
 *          with \n, trailing \n); `title` is the first real user message (cleaned
 *          of command chrome) — for the threads row title/preview.
 */
export function claudeToRollout(claudeJsonl, opts = {}) {
  const sessionId = opts.sessionId || randomUUID();
  const cwd = opts.cwd || '';
  const model = opts.model || 'gpt-5.4';
  const modelProvider = opts.modelProvider || 'openai';
  const timezone = opts.timezone || 'UTC';
  const now = opts.now || new Date();
  const ts = now.toISOString();
  const dateStr = ts.slice(0, 10);
  const cliVersion = opts.cliVersion || '';
  const baseInstructions = opts.baseInstructions ||
    '(bridged from a Claude Code session — conversation history only; tool calls summarized as prose)';

  const out = [];
  const emit = (type, payload, timestamp = ts) =>
    out.push(JSON.stringify({ timestamp, type, payload }));

  emit('session_meta', {
    session_id: sessionId, id: sessionId, timestamp: ts, cwd,
    originator: 'codex-tui', cli_version: cliVersion, source: 'cli',
    thread_source: 'user', model_provider: modelProvider,
    base_instructions: { text: baseInstructions },
  });

  const sandboxPolicy = { type: 'workspace-write', network_access: false };
  const epochSec = Math.floor(now.getTime() / 1000);

  let titleText = '';
  let asstBuf = null; // { text, tools[] } for the in-flight assistant turn
  let turn = null;    // { turn_id, startedAt }

  const startTurn = (userText) => {
    const turn_id = randomUUID();
    emit('event_msg', { type: 'task_started', turn_id, started_at: epochSec, model_context_window: 258400, collaboration_mode_kind: 'default' });
    emit('turn_context', { turn_id, cwd, workspace_roots: cwd ? [cwd] : [], current_date: dateStr, timezone, approval_policy: 'on-request', sandbox_policy: sandboxPolicy, model, personality: 'pragmatic', collaboration_mode: { mode: 'default' }, realtime_active: false, effort: 'medium', summary: 'auto' });
    emit('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }], internal_chat_message_metadata_passthrough: { turn_id } });
    emit('event_msg', { type: 'user_message', message: userText, images: [], local_images: [], text_elements: [{ byte_range: { start: 0, end: userText.length }, placeholder: userText }] });
    return { turn_id, startedAt: epochSec };
  };
  const endTurn = (t, lastAgent = '') => {
    emit('event_msg', { type: 'task_complete', turn_id: t.turn_id, last_agent_message: lastAgent, completed_at: epochSec, duration_ms: Math.max(0, (epochSec - t.startedAt) * 1000), time_to_first_token_ms: 0 });
  };
  const emitAssistant = (turn_id, text) => {
    const id = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
    emit('response_item', { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id } });
    emit('event_msg', { type: 'agent_message', message: text, phase: 'final_answer', memory_citation: null });
  };
  const flushAsst = () => {
    if (!asstBuf) return null;
    if (!asstBuf.text && !asstBuf.tools.length) { asstBuf = null; return null; }
    let text = asstBuf.text || '';
    if (asstBuf.tools.length) {
      const note = asstBuf.tools.map((t) => `[bridged tool call: ${t}]`).join('\n');
      text = text ? `${text}\n\n${note}` : note;
    }
    asstBuf = null;
    return text;
  };

  const lines = String(claudeJsonl || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.isSidechain) continue;

    if (o.type === 'assistant') {
      if (!asstBuf) asstBuf = { text: '', tools: [] };
      const c = o.message && o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            asstBuf.text += (asstBuf.text ? '\n' : '') + b.text;
          } else if (b.type === 'tool_use') {
            asstBuf.tools.push(`${shortToolName(b.name)}${formatToolArg(b.input)}`);
          }
          // thinking / other blocks → skip
        }
      }
    } else if (o.type === 'user') {
      const c = o.message && o.message.content;
      let txt = null;
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) {
        txt = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') || null;
      }
      if (txt) txt = stripCommandChrome(txt);
      if (txt) {
        // a real user message closes any in-flight assistant turn
        const asstText = flushAsst();
        if (turn) {
          if (asstText) emitAssistant(turn.turn_id, asstText);
          endTurn(turn, asstText || '');
          turn = null;
        }
        if (!titleText) titleText = txt.slice(0, 200);
        turn = startTurn(txt);
      }
      // tool_result-only user lines belong to the ongoing assistant turn → skip
    }
    // non-conversational types (mode/system/attachment/summary/…) → skip
  }
  // flush a trailing assistant turn with no following user message
  {
    const asstText = flushAsst();
    if (turn) {
      if (asstText) emitAssistant(turn.turn_id, asstText);
      endTurn(turn, asstText || '');
      turn = null;
    }
  }

  return { rollout: out.join('\n') + '\n', title: titleText };
}

// --- CLI entry (manual testing): node claude-to-rollout.mjs <claude.jsonl> -----
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: claude-to-rollout.mjs <claude.jsonl>');
    process.exit(2);
  }
  const src = readFileSync(file, 'utf8');
  const { rollout, title } = claudeToRollout(src, {
    cwd: process.cwd(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  process.stdout.write(rollout);
  process.stderr.write(`[title] ${title.slice(0, 80)}\n`);
}

const invokedDirectly = import.meta.url &&
  process.argv[1] && process.argv[1].endsWith('claude-to-rollout.mjs');
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
