/**
 * codex.mjs — OpenAI Codex CLI agent adapter.
 *
 * Codex stores sessions as rollout JSONL under
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl
 *   (default $CODEX_HOME = ~/.codex)
 *
 * Each line is a wrapper object: { timestamp, type, payload }
 *   - type 'session_meta'   → payload.session_id (== thread_id, == filename
 *                             trailing UUID), payload.cwd, payload.cli_version
 *   - type 'event_msg'      → payload.type in {user_message, agent_message,
 *                             token_count, task_started, task_complete, ...}
 *                             (messages carry a STRING `message` field)
 *   - type 'response_item'  → payload.type in {message, reasoning, function_call,
 *                             function_call_output, custom_tool_call, ...}
 *                             (function_call.arguments is a JSON STRING;
 *                              custom_tool_call.input is a patch text)
 *   - type 'turn_context'   → per-turn metadata (cwd, model, sandbox, …)
 *
 * NOTE: the `codex exec --json` STDOUT stream uses a different, flat shape
 * (thread.started / item.completed). This adapter parses the on-disk rollout
 * format under ~/.codex/sessions, which is what we sync.
 *
 * The push path only consumes getRawJsonlContent() → raw bytes, so parseSession
 * is best-effort (for jira_parse_session + future hooks); it tolerates unknown
 * lines and item variants.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

/** The AI client type this adapter represents. Part of the terminal identity. */
export const CLIENT_TYPE = 'codex';

/** Detect the Codex client version from the environment (best-effort). */
export function detectClientVersion(env = process.env) {
  return env.CODEX_VERSION || 'unknown';
}

/** Resolve the sessions root ($CODEX_HOME/sessions), with a rootDir override. */
function getSessionsDir(opts = {}) {
  if (opts && opts.rootDir) return opts.rootDir;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

/** Encode a cwd into the same `-`-joined namespace Claude uses (e.g. -Users-x-proj
 *  on mac/linux, d--home-... on Windows). Replace every path separator AND the
 *  Windows drive-letter colon; mac/linux cwd has none of [\:], so this is a
 *  no-op there and only fixes Windows. */
function encodeCwd(cwd) {
  return String(cwd || '').replace(/[\\/:]/g, '-');
}

/** Extract readable text from a message field (string | block array | object). */
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && (b.text || b.content)) || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'object') return String(content.text || content.content || '').trim();
  return '';
}

/** Parse a value that may be a JSON string or already an object. */
function parseJsonLoose(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** Pull file changes out of a Codex apply_patch text (`*** Update/Add/Delete File: <path>`). */
function extractFileChangesFromPatch(patchText) {
  if (typeof patchText !== 'string') return [];
  const out = [];
  const re = /\*\*\* (Update|Add|Delete) File: ([^\n]+)/g;
  let m;
  while ((m = re.exec(patchText))) {
    const action = m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit';
    out.push({ action, path: m[2].trim() });
  }
  return out;
}

/** Read only the first line of a file (up to maxBytes) — synchronous, cheap. */
function readFirstLine(filePath, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const slice = buf.subarray(0, n);
    const nl = slice.indexOf(0x0a);
    return (nl === -1 ? slice : slice.subarray(0, nl)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Read the session_meta payload from the first line ({} if unparseable). */
function readSessionMeta(filePath) {
  try {
    const o = JSON.parse(readFirstLine(filePath));
    if (o && o.type === 'session_meta') return o.payload || {};
    return o || {};
  } catch {
    return {};
  }
}

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** Recursively collect *.jsonl under dir. */
function walkJsonl(dir, cb) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, cb);
    else if (e.isFile() && e.name.endsWith('.jsonl')) cb(p);
  }
}

/** All *.jsonl under the sessions root, newest mtime first. */
function listJsonlByMtimeDesc(root) {
  const out = [];
  walkJsonl(root, (p) => out.push(p));
  out.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  return out;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Find a session file by session_id (== thread_id). The id is the trailing UUID
 * in the rollout filename (rollout-<ts>-<session_id>.jsonl), so try a filename
 * match first (cheap); fall back to reading each file's session_meta.session_id.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.rootDir] - Override the sessions root (tests).
 * @returns {string|null}
 */
export function findSessionFile(sessionId, opts = {}) {
  if (!sessionId) return null;
  const root = getSessionsDir(opts);
  const files = listJsonlByMtimeDesc(root);
  // 1. Filename match (trailing UUID).
  for (const f of files) {
    const base = path.basename(f, '.jsonl');
    if (base.endsWith(sessionId) || base.includes(sessionId)) return f;
  }
  // 2. session_meta.session_id match.
  for (const f of files) {
    const meta = readSessionMeta(f);
    if (meta.session_id === sessionId || meta.id === sessionId) return f;
  }
  return null;
}

/**
 * Find the most recently modified rollout file.
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @returns {string|null}
 */
export function findLatestSessionFile(opts = {}) {
  const root = getSessionsDir(opts);
  return listJsonlByMtimeDesc(root)[0] || null;
}

/**
 * Find the current project's session by matching session_meta.cwd against the
 * process cwd; falls back to the latest rollout.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @param {string} [opts.cwd] - Override process.cwd() (tests).
 * @returns {string|null}
 */
export function findCurrentProjectSession(opts = {}) {
  const root = getSessionsDir(opts);
  const cwd = opts.cwd || process.cwd();
  const files = listJsonlByMtimeDesc(root);
  for (const f of files) {
    if (readSessionMeta(f).cwd === cwd) return f;
  }
  return files[0] || null;
}

// ---------------------------------------------------------------------------
// Raw JSONL content extraction (push contract)
// ---------------------------------------------------------------------------

/**
 * Read the raw rollout JSONL. sessionId comes from session_meta.session_id;
 * projectName is the cwd-encoded namespace (shared shape with Claude).
 *
 * @param {object} [options]
 * @param {string} [options.filePath]
 * @param {string} [options.sessionId] - session_id (thread_id)
 * @param {string} [options.rootDir] - sessions root override (tests)
 * @returns {Promise<{content:string, filePath:string, sessionId:string, projectName:string}|null>}
 */
export async function getRawJsonlContent(options = {}) {
  const opts = options.rootDir ? { rootDir: options.rootDir } : {};
  let filePath;

  if (options.filePath) {
    filePath = options.filePath;
  } else if (options.sessionId) {
    filePath = findSessionFile(options.sessionId, opts);
  } else {
    filePath = findCurrentProjectSession(opts) || findLatestSessionFile(opts);
  }

  if (!filePath) return null;

  const meta = readSessionMeta(filePath);
  const sessionId = meta.session_id || meta.id || path.basename(filePath, '.jsonl');
  const projectName = meta.cwd ? encodeCwd(meta.cwd) : path.basename(filePath, '.jsonl');
  const content = fs.readFileSync(filePath, 'utf8');

  return { content, filePath, sessionId, projectName };
}

// ---------------------------------------------------------------------------
// Parsing (best-effort, same output shape as the Claude adapter)
// ---------------------------------------------------------------------------

/**
 * Parse a Codex rollout JSONL file into the shared ParsedSession shape.
 * Tolerates unknown event/item types (they are skipped). Used by
 * jira_parse_session and (future) hook decisions; the push path does NOT
 * depend on this — it sends raw bytes.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function parseSession(filePath) {
  const result = {
    sessionId: null,
    projectName: extractProjectName(filePath),
    startTime: null,
    endTime: null,
    duration: null,
    humanMessages: [],
    assistantMessages: [],
    fileChanges: [],
    commandsExecuted: [],
    toolInteractions: [],
    skillsUsed: [],
    tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    rawEntries: [],
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = entry.timestamp || null;
    if (ts) {
      if (!result.startTime || ts < result.startTime) result.startTime = ts;
      if (!result.endTime || ts > result.endTime) result.endTime = ts;
    }
    result.rawEntries.push({ type: entry.type || 'unknown', timestamp: ts });

    const etype = entry.type;
    const payload = entry.payload || {};

    if (etype === 'session_meta') {
      if (payload.session_id) result.sessionId = payload.session_id;
      if (payload.cwd) result.projectName = encodeCwd(payload.cwd);
    } else if (etype === 'event_msg') {
      handleEventMsg(payload, ts, result);
    } else if (etype === 'response_item') {
      handleResponseItem(payload, ts, result);
    }
    // turn_context and unknown wrappers are intentionally skipped.
  }

  if (!result.sessionId) result.sessionId = path.basename(filePath, '.jsonl');

  if (result.startTime && result.endTime) {
    const start = new Date(result.startTime).getTime();
    const end = new Date(result.endTime).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      result.duration = formatDuration(end - start);
    }
  }

  result.tokenUsage.total =
    result.tokenUsage.input + result.tokenUsage.output +
    result.tokenUsage.cacheCreate + result.tokenUsage.cacheRead;

  return result;
}

/** Handle an event_msg payload (messages + token usage live here). */
function handleEventMsg(payload, ts, result) {
  const t = payload.type;
  if (t === 'user_message') {
    const text = extractText(payload.message);
    if (text) result.humanMessages.push({ timestamp: ts, text });
  } else if (t === 'agent_message') {
    const text = extractText(payload.message);
    if (text) result.assistantMessages.push({ timestamp: ts, text, toolsUsed: [] });
  } else if (t === 'token_count') {
    // total_token_usage is CUMULATIVE across the session — take the latest
    // event's value rather than summing every event (which would multiply by
    // the turn count).
    const u = (payload.info && payload.info.total_token_usage) || {};
    if (u.input_tokens) result.tokenUsage.input = u.input_tokens;
    if (u.cached_input_tokens) result.tokenUsage.cacheRead = u.cached_input_tokens; // Codex cached → Claude cacheRead
    if (u.output_tokens) result.tokenUsage.output = u.output_tokens;
  }
}

/** Handle a response_item payload (tool calls + file changes live here). */
function handleResponseItem(payload, ts, result) {
  const t = payload.type;
  if (t === 'function_call') {
    const name = payload.name;
    const args = parseJsonLoose(payload.arguments) || {};
    result.toolInteractions.push({ type: 'tool_use', toolName: name, input: args });
    if (name === 'exec_command' || name === 'shell') {
      const cmd = args.cmd || args.command || '';
      if (cmd) result.commandsExecuted.push({ tool: 'shell', command: String(cmd) });
    }
  } else if (t === 'custom_tool_call') {
    const name = payload.name;
    const input = payload.input;
    result.toolInteractions.push({
      type: 'tool_use',
      toolName: name,
      input: typeof input === 'string' ? { patch_length: input.length } : (input || {}),
    });
    // apply_patch-style tools carry the patch as a string in `input`.
    const changes = extractFileChangesFromPatch(input);
    for (const c of changes) result.fileChanges.push(c);
  }
  // 'message' / 'reasoning' / 'function_call_output' / 'custom_tool_call_output'
  // are skipped: messages are read from event_msg (cleaner, no developer/system
  // noise), and outputs are redundant with the call.
}

/**
 * Derive the project namespace from a rollout file (cwd-encoded from
 * session_meta, else the filename).
 * @param {string} filePath
 */
export function extractProjectName(filePath) {
  const meta = readSessionMeta(filePath);
  if (meta.cwd) return encodeCwd(meta.cwd);
  return path.basename(filePath, '.jsonl');
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hours}h${mins > 0 ? ` ${mins}min` : ''}`;
}

// ---------------------------------------------------------------------------
// Adapter facade (see lib/agents/types.mjs)
// ---------------------------------------------------------------------------

export const codexAdapter = {
  CLIENT_TYPE,
  detectClientVersion,
  findSessionFile,
  findLatestSessionFile,
  findCurrentProjectSession,
  getRawJsonlContent,
  parseSession,
  extractProjectName,
};
