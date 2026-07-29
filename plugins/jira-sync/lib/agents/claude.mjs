/**
 * claude.mjs — Claude Code agent adapter.
 *
 * Logic moved verbatim from lib/transcript-parser.mjs (parseSession + helpers
 * + file discovery); the only change is ROOT_DIR is now resolved via
 * getRootDir(opts) so it can be overridden (CLI --dir) while defaulting to
 * ~/.claude/projects (unchanged behavior when opts is absent). Adds the
 * agent-identity bits (CLIENT_TYPE, detectClientVersion) and the claudeAdapter
 * facade so lib/agents/index.mjs can dispatch to it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

/** The AI client type this adapter represents. Part of the terminal identity. */
export const CLIENT_TYPE = 'claude-code';

/** Claude Code stores session transcripts under ~/.claude/projects/. */
const DEFAULT_ROOT_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Resolve the projects root, allowing an override (used by the CLI --dir flag). */
function getRootDir(opts = {}) {
  return opts && opts.rootDir ? opts.rootDir : DEFAULT_ROOT_DIR;
}

/** Detect the Claude Code client version from the environment. */
export function detectClientVersion(env = process.env) {
  return env.CLAUDE_CODE_VERSION || env.CLAUDE_CODE_ENTRYPOINT_VERSION || 'unknown';
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single session JSONL file
 * @param {string} filePath - Path to the JSONL file
 * @returns {Promise<object>} Structured session data
 */
export async function parseSession(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  const projectName = extractProjectName(filePath);
  const seenUuids = new Set();
  const seenRequestIds = new Map(); // requestId → { usage, contentBlocks }

  const result = {
    sessionId,
    projectName,
    startTime: null,
    endTime: null,
    duration: null,
    humanMessages: [],
    assistantMessages: [],
    fileChanges: [],
    commandsExecuted: [],
    toolInteractions: [],   // tool_use inputs + tool_result outputs
    skillsUsed: [],
    tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    rawEntries: [],         // all entries with type + timestamp for full context
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  // Collect assistant entries grouped by requestId
  const assistantGroups = new Map(); // requestId → { entries[], lastUsage }

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // UUID deduplication (resumed sessions replay history)
    if (entry.uuid) {
      if (seenUuids.has(entry.uuid)) continue;
      seenUuids.add(entry.uuid);
    }

    // Timestamp tracking
    if (entry.timestamp) {
      const ts = entry.timestamp;
      if (!result.startTime || ts < result.startTime) result.startTime = ts;
      if (!result.endTime || ts > result.endTime) result.endTime = ts;
    }

    if (entry.type === 'user') {
      processUserEntry(entry, result);
    } else if (entry.type === 'assistant') {
      processAssistantEntry(entry, assistantGroups, result);
    }

    // Collect raw entry index for full context
    result.rawEntries.push({ type: entry.type, timestamp: entry.timestamp });
  }

  // Aggregate assistant entries
  aggregateAssistantMessages(assistantGroups, result);

  // Calculate duration
  if (result.startTime && result.endTime) {
    const start = new Date(result.startTime).getTime();
    const end = new Date(result.endTime).getTime();
    const diffMs = end - start;
    result.duration = formatDuration(diffMs);
  }

  // Sum tokens
  result.tokenUsage.total =
    result.tokenUsage.input +
    result.tokenUsage.output +
    result.tokenUsage.cacheCreate +
    result.tokenUsage.cacheRead;

  return result;
}

/**
 * Process a user-type entry
 */
function processUserEntry(entry, result) {
  // Skip meta, compact summaries, and sidechains
  if (entry.isMeta || entry.isCompactSummary || entry.isSidechain) return;

  const content = entry.message?.content;
  if (!content) return;

  let text = null;
  let isToolResult = false;

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const first = content[0];
    if (first?.type === 'tool_result') {
      isToolResult = true;
    } else if (first?.type === 'text') {
      text = first.text || '';
    }
  }

  if (isToolResult) {
    // Capture tool results (outputs from tool calls)
    for (const block of content) {
      if (block?.type === 'tool_result') {
        result.toolInteractions.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          isError: block.is_error || false,
          output: summarizeToolResult(block.content),
        });
      }
    }
    return;
  }

  // Filter out auto-continuation messages
  if (text) {
    if (
      text.startsWith('<task-notification') ||
      text.startsWith('<scheduled-wakeup') ||
      text.startsWith('<background-task') ||
      text.startsWith('[Request interrupted')
    ) {
      return;
    }

    // Detect slash commands
    const cmdMatch = text.match(/<command-(?:name|message)>\/?([^<]+)<\/command-/);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      result.skillsUsed.push(cmd);
    }

    // Strip HTML tags
    const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanText) {
      result.humanMessages.push({
        timestamp: entry.timestamp,
        text: cleanText,
      });
    }
  }
}

/**
 * Process an assistant-type entry (group by requestId first)
 */
function processAssistantEntry(entry, groups, result) {
  const msg = entry.message || {};
  const usage = msg.usage;
  const requestId = entry.requestId || msg.id || entry.uuid || 'unknown';

  if (!groups.has(requestId)) {
    groups.set(requestId, { entries: [], lastUsage: null, timestamp: entry.timestamp });
  }
  const group = groups.get(requestId);
  group.entries.push(entry);
  if (entry.timestamp) group.timestamp = entry.timestamp;

  // Keep only the latest usage (last content block carries accurate output_tokens)
  if (usage) {
    group.lastUsage = usage;
  }

  // Extract tool calls
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === 'tool_use') {
        extractToolUse(block, result);
      }
    }
  }
}

/**
 * Extract file changes, commands, and tool interactions from tool calls
 */
function extractToolUse(block, result) {
  const toolName = block.name;
  const input = block.input || {};
  const toolId = block.id || null;

  switch (toolName) {
    case 'Write':
      result.fileChanges.push({ action: 'write', path: input.file_path || '' });
      break;
    case 'Edit':
      result.fileChanges.push({ action: 'edit', path: input.file_path || '' });
      break;
    case 'Bash':
      if (input.command) {
        result.commandsExecuted.push({ tool: 'Bash', command: input.command });
      }
      break;
    case 'Agent':
      // Sub-agent calls are recorded too
      break;
    case 'Skill':
      if (input.skill) {
        result.skillsUsed.push(input.skill);
      }
      break;
  }

  // Capture all tool interactions with full input details
  result.toolInteractions.push({
    type: 'tool_use',
    toolId,
    toolName,
    input: summarizeToolInput(toolName, input),
  });
}

/**
 * Summarize tool input — keeps full detail for most tools,
 * truncates only very large content (e.g. file bodies in Write)
 */
function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case 'Read':
      return { file_path: input.file_path };
    case 'Write':
      return {
        file_path: input.file_path,
        content_length: (input.content || '').length,
        content_preview: (input.content || '').slice(0, 500),
      };
    case 'Edit':
      return {
        file_path: input.file_path,
        old_string_length: (input.old_string || '').length,
        new_string_length: (input.new_string || '').length,
        old_string_preview: (input.old_string || '').slice(0, 300),
        new_string_preview: (input.new_string || '').slice(0, 300),
      };
    case 'Bash':
      return { command: input.command, description: input.description };
    case 'Agent':
      return { description: input.description, subagent_type: input.subagent_type };
    case 'Skill':
      return { skill: input.skill, args: input.args };
    case 'AskUserQuestion':
      return summarizeAskUserQuestion(input);
    case 'ExitPlanMode':
      return summarizeExitPlanMode(input);
    default:
      // For unknown tools, keep a reasonable snapshot
      const keys = Object.keys(input);
      const snapshot = {};
      for (const k of keys.slice(0, 10)) {
        const v = input[k];
        if (typeof v === 'string' && v.length > 500) {
          snapshot[k] = v.slice(0, 500) + `... (${v.length} chars)`;
        } else {
          snapshot[k] = v;
        }
      }
      return snapshot;
  }
}

/**
 * Aggregate assistant message groups
 */
function aggregateAssistantMessages(groups, result) {
  for (const [requestId, group] of groups) {
    // Accumulate token usage
    if (group.lastUsage) {
      const u = group.lastUsage;
      result.tokenUsage.input += u.input_tokens || 0;
      result.tokenUsage.output += u.output_tokens || 0;
      result.tokenUsage.cacheCreate += u.cache_creation_input_tokens || 0;
      result.tokenUsage.cacheRead += u.cache_read_input_tokens || 0;
    }

    // Extract text responses
    let textParts = [];
    for (const entry of group.entries) {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
      }
    }

    if (textParts.length > 0) {
      const fullText = textParts.join('\n');
      result.assistantMessages.push({
        timestamp: group.timestamp,
        text: fullText,
        toolsUsed: extractToolsFromGroup(group),
      });
    }
  }
}

/**
 * Extract tool names used in an assistant group
 */
function extractToolsFromGroup(group) {
  const tools = new Set();
  for (const entry of group.entries) {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name) {
          tools.add(block.name);
        }
      }
    }
  }
  return [...tools];
}

/** Truncate a string to `max` chars, appending an indicator when cut. */
function truncateText(text, max) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + `\n... (${text.length} chars total)`;
}

/**
 * AskUserQuestion carries the human-decision prompt — question text, header,
 * and the option labels the user chose among. Capture it verbatim (truncating
 * only oversized text) instead of collapsing to a count. `questions_count` is
 * kept for backwards-compat. Must stay in sync with session-parser.ts.
 */
function summarizeAskUserQuestion(input) {
  const questions = (input.questions || []).map((q) => ({
    question: truncateText(q?.question || '', 500),
    header: q?.header || '',
    options: (q?.options || []).map((o) => o?.label || ''),
  }));
  return { questions_count: questions.length, questions };
}

/**
 * ExitPlanMode carries the proposed plan + requested permissions — the
 * approval artifact. Keep the plan at a generous cap rather than the generic
 * 500-char snapshot truncation. Must stay in sync with session-parser.ts.
 */
function summarizeExitPlanMode(input) {
  return {
    plan: truncateText(input.plan || '', 2000),
    allowedPrompts: (input.allowedPrompts || []).map((p) => ({
      tool: p?.tool || '',
      prompt: truncateText(p?.prompt || '', 300),
    })),
  };
}

/**
 * Summarize a tool_result's output. The `content` field of a `tool_result`
 * block is EITHER a plain string OR an array of content blocks (e.g.
 * `[{ type: 'text', text }]`). Accept both; truncate each text piece to 2000.
 * Must stay in sync with session-parser.ts.
 */
function summarizeToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') {
    return truncateText(content, 2000);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        parts.push(truncateText(block.text, 2000));
      }
    }
    return parts.join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** True if `filePath` is inside a `subagents` or `workflows` directory segment,
 *  regardless of OS path separator. The prior `/subagents/` literal check only
 *  matched POSIX paths and silently let Windows backslash paths through (so a
 *  subagent/workflow session could be picked as "latest"). Splitting on BOTH
 *  separators and matching the exact segment keeps mac/linux behavior identical
 *  while fixing Windows. */
export function isSubagentOrWorkflow(filePath) {
  const segs = String(filePath).split(/[\\/]/);
  return segs.includes('subagents') || segs.includes('workflows');
}

/**
 * Find a session file by session ID
 * @param {string} sessionId - Session ID
 * @param {object} [opts]
 * @param {string} [opts.rootDir] - Override the projects root (CLI --dir).
 * @returns {string|null} File path
 */
export function findSessionFile(sessionId, opts = {}) {
  const root = getRootDir(opts);
  return findInDir(root, (filePath) => {
    const base = path.basename(filePath, '.jsonl');
    return base === sessionId && !isSubagentOrWorkflow(filePath);
  });
}

/**
 * Find the latest session file
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @returns {string|null} File path
 */
export function findLatestSessionFile(opts = {}) {
  const root = getRootDir(opts);
  let latest = null;
  let latestTime = 0;

  walkJsonl(root, (filePath) => {
    // Skip subagent and workflow files
    if (isSubagentOrWorkflow(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latest = filePath;
      }
    } catch { /* ignore */ }
  });

  return latest;
}

/**
 * Find the latest session file for the current project.
 *
 * Uses exact project directory matching: lists directories under the root,
 * finds the best match for the cwd, then searches only within that directory.
 * This avoids false prefix matches (e.g. "ai-co-work" matching "ai-co-work-claude-jira-session-sync").
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @param {string} [opts.cwd] - Override process.cwd() (tests).
 * @param {string} [opts.envSessionId] - Override CLAUDE_CODE_SESSION_ID (tests).
 * @returns {string|null} Latest session file for the current project
 */
export function findCurrentProjectSession(opts = {}) {
  const root = getRootDir(opts);

  // Strategy 1: Use CLAUDE_CODE_SESSION_ID env var if available.
  // Claude Code sets this for MCP servers and hooks — it's the exact
  // current session ID, no guessing needed.
  const envSessionId = opts.envSessionId !== undefined ? opts.envSessionId : process.env.CLAUDE_CODE_SESSION_ID;
  if (envSessionId) {
    const file = findSessionFile(envSessionId, opts);
    if (file) return file;
  }

  // Strategy 2: Fallback — find the latest session file across all
  // candidate project directories matching cwd.
  // Encode cwd into Claude's project-directory-namespace form: replace every
  // path separator AND the Windows drive-letter colon. mac/linux cwd has none
  // of [\:], so they are unaffected; on Windows `d:\home\...` becomes
  // `d--home-...` to match the directory Claude actually created on disk.
  const cwd = (opts.cwd || process.cwd()).replace(/[\\/:]/g, '-');

  let candidates = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      if (cwd === dirName || cwd.startsWith(dirName + '-')) {
        candidates.push(dirName);
      }
    }
  } catch { /* ignore */ }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return findLatestInDir(path.join(root, candidates[0]));
  }

  // Multiple candidates: pick the one with the most recently modified session.
  let bestFile = null;
  let bestTime = 0;
  for (const dirName of candidates) {
    const dirPath = path.join(root, dirName);
    const latest = findLatestInDir(dirPath);
    if (latest) {
      try {
        const stat = fs.statSync(latest);
        if (stat.mtimeMs > bestTime) {
          bestTime = stat.mtimeMs;
          bestFile = latest;
        }
      } catch { /* ignore */ }
    }
  }
  return bestFile;
}

// ---------------------------------------------------------------------------
// Raw JSONL content extraction (for push/restore replay data)
// ---------------------------------------------------------------------------

/**
 * Read the raw JSONL content of a session file.
 * Reuses findSessionFile() or findCurrentProjectSession() for discovery.
 *
 * @param {object} [options]
 * @param {string} [options.filePath] - Specific file to read directly
 * @param {string} [options.sessionId] - Specific session ID to find
 * @param {boolean} [options.currentProject] - Find current project's session instead
 * @param {string} [options.rootDir] - Override the projects root (CLI --dir)
 * @returns {Promise<{content: string, filePath: string, sessionId: string, projectName: string}|null>}
 */
export async function getRawJsonlContent(options = {}) {
  const opts = options.rootDir ? { rootDir: options.rootDir } : {};
  let filePath;

  if (options.filePath) {
    filePath = options.filePath;
  } else if (options.sessionId) {
    filePath = findSessionFile(options.sessionId, opts);
  } else {
    // mtime-first — MUST match resolveSession() in mcp-server/index.mjs so that
    // jira_push_session and jira_parse_session resolve the SAME session.
    //
    // The MCP server is a long-lived stdio process reused across Claude Code
    // sessions; CLAUDE_CODE_SESSION_ID is injected at launch and never
    // refreshed. So findCurrentProjectSession()'s env-var Strategy 1 resolves to
    // the session the server STARTED in, not the current one — env-first here
    // made a manual push send the wrong session (APDEVIMP-49). mtime-first picks
    // the actually-current (most-recently-modified) session. findCurrentProjectSession
    // stays as a fallback for the (fresh-env) hook path that reaches this branch.
    filePath = findLatestSessionFile(opts) || findCurrentProjectSession(opts);
  }

  if (!filePath) return null;

  const sessionId = path.basename(filePath, '.jsonl');
  const content = fs.readFileSync(filePath, 'utf8');
  const projectName = extractProjectName(filePath, opts);

  return { content, filePath, sessionId, projectName };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Find the most recently modified session file in a directory
 */
function findLatestInDir(dir) {
  let latest = null;
  let latestTime = 0;

  walkJsonl(dir, (filePath) => {
    if (isSubagentOrWorkflow(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latest = filePath;
      }
    } catch { /* ignore */ }
  });

  return latest;
}

function walkJsonl(dir, callback) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, callback);
    else if (e.isFile() && e.name.endsWith('.jsonl')) callback(p);
  }
}

function findInDir(dir, predicate) {
  let result = null;
  walkJsonl(dir, (filePath) => {
    if (!result && predicate(filePath)) result = filePath;
  });
  return result;
}

/**
 * Derive the project namespace from a session file path.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 */
export function extractProjectName(filePath, opts = {}) {
  const root = getRootDir(opts);
  const rel = path.relative(root, filePath);
  const parts = rel.split(path.sep);
  return parts[0] || 'unknown';
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hours}h${mins > 0 ? ` ${mins}min` : ''}`;
}

function formatTokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Adapter facade (see lib/agents/types.mjs)
// ---------------------------------------------------------------------------

export const claudeAdapter = {
  CLIENT_TYPE,
  detectClientVersion,
  findSessionFile,
  findLatestSessionFile,
  findCurrentProjectSession,
  getRawJsonlContent,
  parseSession,
  extractProjectName,
};

export { formatTokenCount };
