#!/usr/bin/env node
/**
 * MCP Server for Claude Code Jira Session Sync
 *
 * stdio-based Model Context Protocol server. Session-sync only — Jira CRUD
 * (create-issue / comment / JQL / attachments) is handled by the official
 * Atlassian plugin, not here. Auth is an OAuth 2.1 app-scoped token pair kept
 * in the OS keychain (lib/keychain.mjs); the ForgeClient loads/rotates it.
 *
 * Tools:
 *   - jira_parse_session
 *   - jira_test_connection   (validates the OAuth token against the web trigger)
 *   - jira_push_session / jira_link_session / jira_unlink_session /
 *     jira_list_sessions / jira_list_issue_sessions / jira_restore_session /
 *     jira_get_session / jira_delete_session
 *   - jira_backup_user_settings  (back up ~/.claude/settings.json; secrets redacted locally before upload)
 *   - jira_restore_user_settings  (restore & merge ~/.claude/settings.json; local secrets preserved)
 */

// Top-level error handlers required by Claude Code's MCP launcher
process.on('uncaughtException', (e) => {
  process.stderr.write('UNCAUGHT: ' + e.message + '\n' + e.stack + '\n');
});
process.on('unhandledRejection', (e) => {
  process.stderr.write('UNHANDLED: ' + (e instanceof Error ? e.message + '\n' + e.stack : String(e)) + '\n');
});

import { ForgeClient } from '../lib/forge-client.mjs';
import { pushSession } from '../lib/push.mjs';
import { acquireSessionLock } from '../lib/session-lock.mjs';
import { getAdapter, detectAgent } from '../lib/agents/index.mjs';
import { STATE_BASE_DIR } from '../lib/paths.mjs';

/**
 * The agent this MCP server runs under. Auto-detected from the environment
 * (CODEX_HOME / CODEX_VERSION → codex; CLAUDE_CODE_* markers → claude; else
 * claude) or pinned via JIRA_SYNC_AGENT. Existing Claude-only users have no
 * markers, so this stays 'claude' — zero behavior change. Per-call `agent`
 * tool params can still override the adapter for a single invocation.
 */
const agentName = detectAgent();
const adapter = getAdapter(agentName);
import { loadConfig, checkConfig, ConfigError } from '../lib/config.mjs';
import { loadLocalSettings, redactSecrets, checksumOf } from '../lib/settings-backup.mjs';
import { isPlainObject, deepMerge, SECRET_KEY_RE } from '../lib/settings-restore.mjs';
import { loadClaudeJson, slimClaudeJson } from '../lib/claude-json-backup.mjs';
import { collectResources } from '../lib/resource-backup.mjs';
import { collectMemory } from '../lib/memory-backup.mjs';
import { collectPlugins } from '../lib/plugins-backup.mjs';
import { loadCodexConfig, redactTomlSecrets } from '../lib/codex-config-backup.mjs';
import { collectCodexBackup } from '../lib/codex-backup.mjs';
import { resolveClientIdentity } from '../lib/client-identity.mjs';
import { resolveCodexRestorePath } from '../lib/restore-target.mjs';
import { claudeToRollout } from '../lib/claude-to-rollout.mjs';
import { convertToJsonl } from '../lib/restore-fallback.mjs';
import { linkSessionTool } from '../lib/link-session.mjs';
import { registerCodexThread } from '../lib/codex-threads-register.mjs';
import { extractAiTitle } from '../lib/ai-title.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/** Best-effort read of model_provider + model from $CODEX_HOME/config.toml, used
 *  for the converted Codex rollout's session_meta/turn_context. The stored values
 *  are historical metadata — `codex resume` uses its own live config to run. */
function readCodexConfigBestEffort() {
  try {
    const tomlPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    const toml = readFileSync(tomlPath, 'utf8');
    const mp = toml.match(/^model_provider\s*=\s*"([^"]+)"/m);
    const m = toml.match(/^model\s*=\s*"([^"]+)"/m);
    return { modelProvider: mp ? mp[1] : 'openai', model: m ? m[1] : 'gpt-5.4' };
  } catch {
    return { modelProvider: 'openai', model: 'gpt-5.4' };
  }
}

// ---------------------------------------------------------------------------
// MCP Protocol helpers
// ---------------------------------------------------------------------------

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'jira_test_connection',
    description: 'Validate the OAuth access token against the Forge Session Tracker web trigger.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jira_parse_session',
    description: 'Parse a Claude Code session transcript and return structured data. Does not push to Jira.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to parse. Uses current/latest if omitted.' },
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Agent whose session to parse (claude or codex). Defaults to auto-detected.' },
      },
    },
  },
  // Forge Session Tracker tools
  {
    name: 'jira_push_session',
    description: 'Push current session to Forge Session Tracker (stores raw JSON for restore and Jira UI browsing). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to push. Uses current/latest if omitted.' },
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Agent whose session to push (claude or codex). Defaults to auto-detected.' },
      },
    },
  },
  {
    name: 'jira_link_session',
    description: 'Link a stored session to a Jira Issue (many-to-many). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to link.' },
        issueKey: { type: 'string', description: 'Jira issue key (e.g. PROJ-123).' },
        context: { type: 'string', description: 'Link context: "auto", "manual", "task-start", "task-end".' },
        note: { type: 'string', description: 'Optional note about this link.' },
      },
      required: ['sessionId', 'issueKey'],
    },
  },
  {
    name: 'jira_unlink_session',
    description: 'Unlink a stored session from a Jira issue (removes the session-link only; the session itself is kept). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID of the link to remove.' },
        linkId: { type: 'string', description: 'Link ID to remove (format: "<sessionId>::<issueKey>").' },
      },
      required: ['sessionId', 'linkId'],
    },
  },
  {
    name: 'jira_list_sessions',
    description: "List stored sessions from Forge Session Tracker, scoped to the caller's token. Requires JIRA_WEBTRIGGER_URL + an OAuth token.",
    inputSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Filter by project name.' },
        limit: { type: 'number', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  {
    name: 'jira_list_issue_sessions',
    description: 'List sessions linked to a specific Jira issue. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Jira issue key (e.g. PROJ-123).' },
      },
      required: ['issueKey'],
    },
  },
  {
    name: 'jira_restore_session',
    description: 'Restore a session from the Forge Session Tracker to this machine, resumable in its own agent (native) or converted to resume in Codex (claude→codex handoff). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to restore.' },
        targetAgent: {
          enum: ['codex'],
          description: 'Restore/convert so the session resumes in Codex. A Claude session is converted to a Codex rollout (tool actions summarized as prose, not replayed) and registered in the Codex session index; a Codex session is restored natively. Omit to restore natively in the session\'s own agent (Claude→~/.claude/projects, Codex→~/.codex/sessions).',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'jira_get_session',
    description: 'Get session detail from Forge Session Tracker (metadata + links, no parsedContent).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'jira_delete_session',
    description: 'Delete one of your stored sessions from Forge Session Tracker (irreversible — removes the session, its linked issues, and the raw transcript). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete.' },
      },
      required: ['sessionId'],
    },
  },
  // AI terminal (client) tools
  {
    name: 'jira_register_client',
    description:
      'Register (or refresh) this machine+agent (Claude Code or Codex) as an AI terminal in the Forge ' +
      'Session Tracker. The clientId is derived locally & deterministically (no secrets); ' +
      're-running is idempotent (updates lastSeenAt + basic info). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Agent to register as (defaults to auto-detected).' },
      },
    },
  },
  {
    name: 'jira_list_clients',
    description:
      "List the current user's AI terminals from the Forge Session Tracker. " +
      'Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Marks this agent terminal as current in the list (defaults to auto-detected).' },
      },
    },
  },
  {
    name: 'jira_get_client',
    description: 'Get one AI terminal detail by clientId. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'Terminal clientId. Uses the current terminal if omitted.' },
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Resolve the current terminal for this agent when clientId is omitted (defaults to auto-detected).' },
      },
    },
  },
  {
    name: 'jira_backup_user_settings',
    description:
      'Backup ~/.claude/settings.json preferences & policies to the Forge Session Tracker ' +
      '(secrets redacted locally before upload), attributed to THIS AI terminal (auto-registered). ' +
      'Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview what would be backed up and which secrets are redacted, without uploading.',
        },
      },
    },
  },
  {
    name: 'jira_backup_claude_config',
    description:
      'Backup ~/.claude.json (global state / account / user-scope MCP) to the Forge Session ' +
      'Tracker. Slimmed locally (cache/stats/projects stripped) and secrets redacted before ' +
      'upload. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview what would be backed up: kept top-level keys, stripped (cache/stats/projects) keys, redacted secret keys, and upload size — without uploading.',
        },
      },
    },
  },
  {
    name: 'jira_backup_resources',
    description:
      'Backup ~/.claude custom assets (rules/, agents/, commands/, skills/, ' +
      'output-styles/, keybindings.json + tree-internal referenced scripts) to the Forge ' +
      'Session Tracker, attributed to THIS AI terminal (auto-registered). Secrets are redacted ' +
      'locally before upload. Memory files (CLAUDE.md / memdir / agent-memory) are backed up ' +
      'separately via jira_backup_memory. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview the grouped file list, redaction & skip summary, and upload size — without uploading.',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['rules', 'agents', 'commands', 'skills', 'output-styles', 'keybindings'],
          },
          description:
            'Optional PARTIAL backup: only these resource sub-categories are collected and, ' +
            'server-side, MERGED into the stored bundle (unselected categories are preserved — ' +
            'a subset backup never wipes the others). `scripts` always rides along. ' +
            'Omit/empty = full backup (replaces the whole bundle).',
        },
      },
    },
  },
  {
    name: 'jira_backup_memory',
    description:
      'Backup Claude Code memory to the Forge Session Tracker, attributed to THIS AI terminal ' +
      '(auto-registered): user memory (~/.claude/CLAUDE.md), per-project auto memory ' +
      '(~/.claude/projects/<proj>/memory/, grouped by project) and per-agent auto memory ' +
      '(~/.claude/agent-memory/<agentType>/, grouped by agent type). Secrets are redacted ' +
      'locally before upload. Session transcripts (*.jsonl) and session-memory are excluded ' +
      '(session history). Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview the grouped memory file list (by category + project/agent group), redaction ' +
            '& scope-optional hints, and upload size — without uploading.',
        },
      },
    },
  },
  {
    name: 'jira_backup_plugins',
    description:
      'Backup the two ~/.claude/plugins manifests — installed_plugins.json (installed ' +
      'plugins) + known_marketplaces.json (marketplace sources) — to the Forge Session ' +
      'Tracker, attributed to THIS AI terminal (auto-registered). Rebuildable dirs ' +
      '(plugins/{cache,repos,marketplaces,data}, plugin-catalog-cache.json, *.bak) are ' +
      'excluded. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview the plugin/marketplace counts, upload size, checksum, and excluded ' +
            'items — without uploading.',
        },
      },
    },
  },
  {
    name: 'jira_backup_codex_config',
    description:
      'Backup ~/.codex/config.toml (model/provider, features, project trust, MCP servers, plugins) ' +
      'to the Forge Session Tracker. Secrets (API keys / tokens in [mcp_servers.*.env]) are redacted ' +
      'locally before upload, and the backup is attributed to THIS Codex terminal (auto-registered). ' +
      'Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview what would be backed up and which secrets are redacted, without uploading.',
        },
      },
    },
  },
  {
    name: 'jira_backup_codex',
    description:
      'Backup THIS Codex terminal\'s full config and custom assets to the Forge Session Tracker in ONE upload: ' +
      'config.toml (settings/global-state/MCP/plugins), custom agents/skills/rules, hooks, AGENTS.md instructions, ' +
      'and ~/.codex/memories/** local memory. Each category is stored separately (own revision/checksum) but sent ' +
      'together. Secrets are redacted locally before upload; the root memories_*.sqlite cache and auth.json are never ' +
      'sent. Attributed to this auto-registered Codex terminal. Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview each category (files, size, redactions, skipped) without uploading.',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['config', 'agents', 'skills', 'rules', 'hooks', 'guidance', 'local-memory'],
          },
          description:
            'Optional selection — back up only these categories (config = config.toml; agents/skills/' +
            'rules/hooks = custom assets; guidance = AGENTS.md; local-memory = ~/.codex/memories). ' +
            'Omit to back up every present category. Unlisted categories are left untouched (each is a ' +
            'separate blob), so a partial backup never removes the others.',
        },
      },
    },
  },
  {
    name: 'jira_restore_user_settings',
    description:
      'Restore ~/.claude/settings.json from Forge Session Tracker backup. ' +
      'Merges cloud preferences & policies with your LOCAL secrets — any local key matching ' +
      'token|secret|password|apiKey|credential|accessKey|privateKey is preserved. ' +
      'The previous local file is backed up to settings.json.bak.<ts> before overwriting. ' +
      'Requires JIRA_WEBTRIGGER_URL + an OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'Source terminal clientId. Uses the most recent backup across all your terminals if omitted.',
        },
        conflictStrategy: {
          type: 'string',
          description: "How to handle an existing local file: 'backup' (rename to .bak then restore — default), 'skip' (keep local unchanged), 'overwrite' (replace without backup).",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

function getForgeClient() {
  const config = loadConfig();
  return new ForgeClient({ webtriggerUrl: config.webtriggerUrl });
}

/**
 * Resolve this terminal's identity (clientId derived locally, no secrets),
 * register/refresh it server-side, and return { clientId, metadata, register }.
 * Called before settings backup so a backup is attributed to the right terminal.
 * Registration is idempotent.
 */
async function ensureClientRegistered(forge, a = adapter) {
  // Identity comes from the agent adapter (CLIENT_TYPE + version), so a Codex MCP
  // server registers a codex terminal and a Claude one a claude terminal.
  const { clientId, metadata } = resolveClientIdentity({
    clientType: a.CLIENT_TYPE,
    clientVersion: a.detectClientVersion(),
  });
  const register = await forge.registerClient({ clientId, ...metadata });
  return { clientId, metadata, register };
}

/** Resolve the current terminal's clientId for the given (or detected) agent. */
function currentClientId(a = adapter) {
  try {
    return resolveClientIdentity({
      clientType: a.CLIENT_TYPE,
      clientVersion: a.detectClientVersion(),
    }).clientId;
  } catch {
    return null;
  }
}

/** Build a Jira browse URL for an issue when a site URL is configured. */
function browseUrl(siteUrl, issueKey) {
  if (!siteUrl || !issueKey) return null;
  return `${siteUrl.replace(/\/+$/, '')}/browse/${issueKey}`;
}

async function resolveSession(sessionId, a = adapter) {
  let filePath;
  if (sessionId) {
    filePath = a.findSessionFile(sessionId);
  } else {
    // Primary: most recently modified session across all projects.
    // This is the most reliable way to find the "current" session,
    // because the MCP server's process.cwd() may not match the user's project dir.
    filePath = a.findLatestSessionFile() || a.findCurrentProjectSession();
  }
  if (!filePath) {
    throw new Error(`No ${a.CLIENT_TYPE} session file found. Make sure you have an active ${a.CLIENT_TYPE} session.`);
  }
  const session = await a.parseSession(filePath);
  // Log which session was resolved for debugging
  process.stderr.write(`[resolveSession] resolved to ${session.sessionId} from ${filePath} (${a.CLIENT_TYPE})\n`);
  return session;
}

/** Pick the adapter for a tool call: an explicit `agent` param overrides the detected default. */
function adapterFor(params) {
  return params && params.agent ? getAdapter(params.agent) : adapter;
}

/**
 * The setup-command token for the agent hosting THIS MCP server — `/jira-setup`
 * under Claude Code, `$jira-setup` under Codex. Used so error/hint strings name
 * a command the user can actually run (Codex has no `/jira-setup`; Claude has no
 * `$jira-setup`).
 */
function setupHint() {
  return agentName === 'codex' ? '$jira-setup' : '/jira-setup';
}

/**
 * Rewrite `/jira-setup` → the agent-appropriate command in a message that came
 * from a lower-level lib (config.mjs / forge-client.mjs), which don't know which
 * agent they're running under. Idempotent for Claude (`/jira-setup` → `/jira-setup`).
 */
function localizeSetupHint(text) {
  return String(text).replace(/\/jira-setup/g, setupHint());
}

const handlers = {
  jira_test_connection: async () => {
    const forge = getForgeClient();
    try {
      const id = await forge.whoami();
      return {
        content: [
          { type: 'text', text: `✅ Authenticated to the Forge Session Tracker as ${id.email} (device ${id.familyId}).` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Connection failed: ${err.message}` }],
        isError: true,
      };
    }
  },

  jira_parse_session: async (params) => {
    const session = await resolveSession(params.sessionId, adapterFor(params));
    return {
      content: [
        {
          type: 'text',
          text: `Session: ${session.sessionId}\nProject: ${session.projectName}\nDuration: ${session.duration}\nMessages: ${session.humanMessages.length} human, ${session.assistantMessages.length} assistant\nFile changes: ${session.fileChanges.length}\nCommands: ${session.commandsExecuted.length}\nTokens: ${session.tokenUsage.total}`,
        },
      ],
    };
  },

  // ---- Forge Session Tracker tools ----

  jira_push_session: async (params) => {
    const forge = getForgeClient();
    const a = adapterFor(params);

    // Read the raw JSONL file — Forge parses it at ingest (single source of truth).
    const rawInfo = await a.getRawJsonlContent({ sessionId: params.sessionId });
    if (!rawInfo) {
      return {
        content: [{
          type: 'text',
          text: `❌ Could not find session file for "${params.sessionId || 'current session'}".`,
        }],
        isError: true,
      };
    }

    const lock = await acquireSessionLock(rawInfo.sessionId, STATE_BASE_DIR, { wait: true });

    try {
      // Unified push path: manual push goes through the SAME shared push module
      // (lib/push.mjs) as auto-push, so it writes the new incremental format AND
      // inherits large-session chunking. A small session is a single fromByte=0
      // init request; a large session (whose one-shot POST would 413 at the web
      // trigger) is split on newline boundaries into init + bounded delta appends.
      // The ForgeClient.appendSession seam throws ResyncError only on a 409 GAP,
      // which cannot occur here (we own the offsets), so it propagates as a hard
      // error if the server state is ever unexpected.
      //
      // No projectKey is sent — project membership is derived from issue links at
      // read time (project-page-resolver Strategy 3: by-issue index with
      // `beginsWith(projectKey + '-')`). Link a session to an issue to place it on
      // that project's Project Page.
      const pushRes = await pushSession({
        mode: 'full',
        resolveSession: async () => rawInfo,
        deps: { send: (p) => forge.appendSession(p) },
        projectPath: process.cwd(),
        agent: params.agent || agentName,
      });

      const sizeKb = Math.max(1, Math.round(pushRes.byteLength / 1024));
      const chunkNote = pushRes.chunked
        ? `\n📦 Raw JSONL sent in ${pushRes.chunks} chunked requests (${sizeKb} KB; the web trigger 413s one-shot bodies over its limit, so the full push is split into bounded appends).`
        : `\n📦 Raw JSONL sent — Forge parses and stores it for rendering + restore.`;
      return {
        content: [
          {
            type: 'text',
            text: `✅ Session pushed to Forge Tracker\n` +
              `Session: ${rawInfo.sessionId}\n` +
              `Project: ${rawInfo.projectName}\n` +
              chunkNote + `\n` +
              `Use jira_link_session to link it to a Jira issue.`,
          },
        ],
      };
    } finally {
      lock?.release?.();
    }
  },

  jira_link_session: async (params) => {
    // Issue-existence validation + result/error formatting live in the pure,
    // unit-tested lib/link-session.mjs (APDEVIMP-47: never silently "✅ linked"
    // a non-existent issue key).
    return linkSessionTool(params, { forge: getForgeClient(), siteUrl: loadConfig().siteUrl });
  },

  jira_unlink_session: async (params) => {
    const forge = getForgeClient();
    const result = await forge.unlinkSession(params.sessionId, params.linkId);

    if (!result?.deleted) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to unlink ${params.linkId}.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `✅ Link removed: ${params.linkId}`,
      }],
    };
  },

  jira_list_sessions: async (params) => {
    const forge = getForgeClient();
    // userId is NOT sent — the server scopes to the caller behind the access token.
    const result = await forge.listSessions({
      projectName: params.projectName,
      limit: params.limit,
    });

    const sessions = sortByRecency(result.sessions || []);
    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: 'No sessions found.' }] };
    }

    const cols = ['#', 'Updated', 'Duration', 'Project', 'Tokens', 'Links', 'Summary', 'Session ID'];
    const rows = sessions.map((s, i) => [
      String(i + 1),
      fmtTime(s.endTime || s.startTime),
      s.duration || '?',
      projectLabel(s),
      fmtToken(s.tokenTotal),
      String(s.linkCount || 0),
      truncate(s.summary, 50),
      s.sessionId,
    ]);

    const text = `Found ${sessions.length} session(s) (most recent first):\n\n` +
      renderTable(cols, rows);

    return { content: [{ type: 'text', text }] };
  },

  jira_list_issue_sessions: async (params) => {
    const forge = getForgeClient();
    const result = await forge.getIssueSessions(params.issueKey);
    // Server returns a bare array (IssueSessionItem[]); normalize defensively.
    const sessions = sortByRecency(Array.isArray(result) ? result : (result.sessions || []));

    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: `No sessions linked to ${params.issueKey}.` }] };
    }

    const cols = ['#', 'Updated', 'Duration', 'Tokens', 'Context', 'Linked', 'Summary', 'Session ID'];
    const rows = sessions.map((s, i) => [
      String(i + 1),
      fmtTime(s.endTime || s.startTime),
      s.duration || '?',
      fmtToken(s.tokenTotal),
      s.context || '?',
      fmtTime(s.linkedAt),
      truncate(s.summary, 50),
      s.sessionId,
    ]);

    const text = `Sessions linked to ${params.issueKey} (${sessions.length}, most recent first):\n\n` +
      renderTable(cols, rows);

    return { content: [{ type: 'text', text }] };
  },

  jira_restore_session: async (params) => {
    const forge = getForgeClient();
    const { sessionId } = params;

    // Session metadata FIRST — its `agent` decides where to write and which
    // resume command to suggest. Restore is driven by the SESSION's agent (a
    // Codex session lands under ~/.codex/sessions so `codex resume` finds it),
    // not by whichever agent hosts this MCP server.
    const detail = await forge.getSession(sessionId);
    if (!detail || !detail.sessionId) {
      return {
        content: [{ type: 'text', text: `❌ Session ${sessionId} not found in Forge Tracker.` }],
        isError: true,
      };
    }
    const projectName = detail.projectName || 'unknown';
    const agent = detail.agent || 'claude';

    // Strategy 1: fetch the original replay (full-fidelity restore). Works for
    // both agents — the stored bytes ARE the agent's native transcript.
    let jsonlContent = null;
    let restoredFrom = 'unknown';
    try {
      const replay = await forge.getSessionReplay(sessionId);
      if (replay && replay.rawJsonl) {
        jsonlContent = replay.rawJsonl;
        restoredFrom = 'original-jsonl';
      }
    } catch { /* replay not available, fall through */ }

    // Strategy 2: reconstruct from parsed data (Claude ONLY). A Codex rollout
    // can't be meaningfully rebuilt into Claude transcript shape — codex restore
    // requires the raw replay (which push always stores as the replay blob).
    if (!jsonlContent && agent === 'claude') {
      const sessionData = await forge.getSessionRaw(sessionId);
      if (sessionData && sessionData.sessionId) {
        jsonlContent = convertToJsonl(sessionData).join('\n') + '\n';
        restoredFrom = 'reconstructed';
      }
    }

    if (!jsonlContent) {
      return {
        content: [{
          type: 'text',
          text: `❌ No raw replay available for ${sessionId} — needed to restore a ${agent} session.`,
        }],
        isError: true,
      };
    }

    // Restore TARGET: native (the session's own agent) unless the caller asks to
    // resume in Codex via targetAgent:"codex". A Claude session is then converted
    // to a Codex rollout so `codex resume` can load it (cross-agent handoff).
    const targetIsCodex = params.targetAgent === 'codex' || agent === 'codex';
    const convertFromClaude = targetIsCodex && agent === 'claude';
    let handoffTitle = '';
    if (convertFromClaude) {
      const codexCfg = readCodexConfigBestEffort();
      const { rollout, title } = claudeToRollout(jsonlContent, {
        sessionId,
        cwd: process.cwd(),
        modelProvider: codexCfg.modelProvider,
        model: codexCfg.model,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      jsonlContent = rollout;
      handoffTitle = title;
      restoredFrom = 'converted-claude→codex';
    }

    // Resolve the target-appropriate path + resume command.
    let targetPath = null;
    let resumeCmd;
    if (targetIsCodex) {
      const { dir, targetPath: tp, resumeCmd: rc } = resolveCodexRestorePath(sessionId);
      try {
        mkdirSync(dir, { recursive: true });
        targetPath = tp;
      } catch { /* leave null, surfaced below */ }
      resumeCmd = rc;
    } else {
      const projectsDir = join(homedir(), '.claude', 'projects');
      const projectDir = findOrCreateProjectDir(projectsDir, projectName);
      if (projectDir) targetPath = join(projectDir, `${sessionId}.jsonl`);
      resumeCmd = `claude --resume ${sessionId}`;
    }

    if (!targetPath) {
      return {
        content: [{
          type: 'text',
          text: `❌ Could not determine restore directory for "${projectName}".\n` +
            (targetIsCodex
              ? `Please ensure ~/.codex/sessions/ is writable.`
              : `Please create the project directory under ~/.claude/projects/ manually and retry.`),
        }],
        isError: true,
      };
    }

    // Check if file already exists locally
    let overwritten = false;
    try {
      const { existsSync } = await import('fs');
      if (existsSync(targetPath)) {
        overwritten = true;
      }
    } catch { /* ignore */ }

    writeFileSync(targetPath, jsonlContent, 'utf8');

    // Preserve the session's real end-time as the file mtime. Without this,
    // writeFileSync stamps mtime = now, so /resume lists a freshly-restored
    // session as "just now" instead of its true age.
    const endMs = detail.endTime && Date.parse(detail.endTime);
    if (endMs) {
      try { utimesSync(targetPath, endMs / 1000, endMs / 1000); } catch { /* non-fatal */ }
    }

    // Codex ≥0.128 keeps its resume index in SQLite (~/.codex/state_5.sqlite
    // `threads`), NOT by scanning rollout files — register the row so
    // `codex resume <id>` finds it. Applies to both cross-agent (claude→codex)
    // and same-agent (codex→codex) restores. Non-fatal: the rollout file is
    // already written; this only affects resume/picker visibility.
    let indexed = '';
    if (targetIsCodex) {
      try {
        const codexCfg = readCodexConfigBestEffort();
        const title = convertFromClaude
          ? handoffTitle
          : (detail.summary || projectName || '(restored codex session)');
        await registerCodexThread({
          sessionId,
          rolloutPath: targetPath,
          cwd: process.cwd(),
          title,
          preview: title,
          modelProvider: codexCfg.modelProvider,
        });
        indexed = '📇 Registered in Codex session index.\n';
      } catch (e) {
        indexed = `⚠️ Could not register in Codex index (${e.message}); the rollout file was written but \`codex resume ${sessionId}\` may not find it.\n`;
      }
    }

    // Resume guidance is agent-aware:
    //  - Claude native: prefer the built-in /resume picker — the file now lives in
    //    the current project dir, so it shows up immediately and resumes in place.
    //    `claude --resume <id>` still works but spawns a separate process AND is
    //    project-scoped (it only looks inside the current cwd's project subdir).
    //  - Codex / cross-agent handoff: keep the explicit `codex resume <id>`.
    let resumeHint;
    if (convertFromClaude) {
      resumeHint = `\nResume with: ${resumeCmd}` +
        '\n\nNote: this is a handoff, not a replay — tool actions are prose summaries; the model understands prior work but can\'t undo/re-execute it.';
    } else if (targetIsCodex) {
      resumeHint = `\nResume with: ${resumeCmd}`;
    } else {
      // Claude Code's /resume picker lists sessions by the AI-generated title,
      // which IS stored in the transcript as the `ai-title` JSONL line (last one
      // wins — Claude Code rewrites it as the topic evolves). That is the exact
      // string the picker shows, so prefer it as the cue. Fall back to the first
      // real user prompt (topic match) when no title has been written yet.
      const aiTitle = extractAiTitle(jsonlContent);
      const firstPrompt = aiTitle ? '' : firstUserPrompt(jsonlContent);
      const pickLabel = aiTitle
        ? `"${truncate(aiTitle, 60)}"`
        : firstPrompt ? `"${truncate(firstPrompt, 60)}"`
        : `ID ${sessionId}`;
      const cue = aiTitle ? 'titled' : firstPrompt ? 'starting with' : 'with';
      resumeHint =
        `\n▶ Resume: type \`/resume\` and look for the one ${cue} ${pickLabel} (current project's picker) — resumes in place.\n` +
        `   Or (reliable, exact ID): \`${resumeCmd}\` in a new terminal — must run from this same project directory (resume is project-scoped).`;
    }

    const fidelity = restoredFrom === 'original-jsonl'
      ? '🎯 Full fidelity (original JSONL)'
      : restoredFrom === 'converted-claude→codex'
        ? '🔄 Converted Claude → Codex rollout (tool actions summarized as prose; not replayed)'
        : '⚠️ Reconstructed from parsed data (tool results may be incomplete)';

    return {
      content: [{
        type: 'text',
        text: `✅ Session ${sessionId} restored${convertFromClaude ? ' (Claude → Codex)' : ` (${agent})`}\n` +
          (detail.summary ? `Summary: ${truncate(detail.summary, 80)}\n` : '') +
          `Written to: ${targetPath}\n` +
          `Project: ${projectName}\n` +
          `Fidelity: ${fidelity}\n` +
          `${overwritten ? '📝 Overwrote existing local session file.\n' : ''}` +
          indexed +
          resumeHint,
      }],
    };
  },

  /**
   * 从 Forge Session Tracker 恢复 ~/.claude/settings.json。
   * 合并云端偏好/策略，保留本机密钥（token/secret/password/apiKey 等字段）。
   */
  jira_restore_user_settings: async (params) => {
    try {
      const forge = getForgeClient();

      // 1. 拉取备份
      let backup;
      try {
        backup = await forge.getUserSettings(params.clientId);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `❌ 获取 settings 备份失败: ${err.message}` }],
          isError: true,
        };
      }

      if (!backup || !backup.content) {
        return {
          content: [{
            type: 'text',
            text: '❌ 未找到 settings 备份。请先在另一台机器运行 /jira-backup-claude 备份。',
          }],
          isError: true,
        };
      }

      // 2. 解析云端内容
      let cloudSettings;
      try {
        cloudSettings = JSON.parse(backup.content);
      } catch {
        return {
          content: [{ type: 'text', text: '❌ 备份内容 JSON 解析失败。' }],
          isError: true,
        };
      }

      // 3. 读取本地 settings
      const settingsPath = join(homedir(), '.claude', 'settings.json');
      let localSettings = {};
      let localExists = false;
      let localSize = 0;
      try {
        if (existsSync(settingsPath)) {
          const raw = readFileSync(settingsPath, 'utf8');
          localSize = Buffer.byteLength(raw, 'utf8');
          localSettings = JSON.parse(raw);
          localExists = true;
        }
      } catch {
        // 本地文件不存在或损坏 — 从零开始
      }

      // 4. 合并：本地密钥保留，云端其余字段覆盖
      const merged = deepMerge(localSettings, cloudSettings, (key, localVal, _cloudVal) => {
        if (SECRET_KEY_RE.test(key)) return localVal;
        return _cloudVal; // cloud wins for non-secret keys
      });

      // 5. 处理本地文件（按冲突策略）
      const strategy = params.conflictStrategy || 'backup';
      let bakPath = null;
      let mergedSize = 0;
      let skipped = false;

      if (localExists && strategy === 'skip') {
        // --skip: 保留本地文件不变
        skipped = true;
      } else {
        // backup / overwrite: 先备份（backup 模式才保留 bak）
        if (localExists && strategy !== 'overwrite') {
          bakPath = settingsPath + '.bak.' + Date.now();
          try {
            writeFileSync(bakPath, JSON.stringify(localSettings, null, 2) + '\n', 'utf8');
          } catch { /* 备份失败不阻塞恢复 */ }
        }

        // 写入合并后的 settings
        const mergedJson = JSON.stringify(merged, null, 2) + '\n';
        writeFileSync(settingsPath, mergedJson, 'utf8');
        mergedSize = Buffer.byteLength(mergedJson, 'utf8');
      }

      const sourceInfo = backup.clientId
        ? `来源终端: ${backup.clientId}\n`
        : '';
      const strategyInfo = strategy !== 'backup' ? `冲突策略: ${strategy}\n` : '';
      const bakInfo = bakPath ? `原本地文件已备份到: ${bakPath}\n` : '';
      const newInfo = skipped
        ? '⏭️  本地文件已存在，已跳过（--skip）'
        : localExists
          ? `（更新前 ${localSize} 字节 → 更新后 ${mergedSize} 字节）`
          : `（新建，${mergedSize} 字节）`;

      return {
        content: [{
          type: 'text',
          text: skipped
            ? `⏭️ 已跳过 — 本地 settings.json 保持不变\n` +
              sourceInfo +
              `属主: ${backup.ownerAccountId}\n` +
              `版本: r${backup.revision}\n` +
              `备份时间: ${backup.backedUpAt}\n` +
              strategyInfo +
              newInfo
            : `✅ Settings 已从 Forge 恢复并合并\n` +
              sourceInfo +
              `属主: ${backup.ownerAccountId}\n` +
              `版本: r${backup.revision}\n` +
              `备份时间: ${backup.backedUpAt}\n` +
              strategyInfo +
              bakInfo +
              newInfo + `\n` +
              `\n💡 本机密钥字段（token/secret/password/apiKey 等）已保留，云端偏好/策略/权限已导入。`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ 恢复 settings 失败: ${err.message}` }],
        isError: true,
      };
    }
  },

  jira_get_session: async (params) => {
    const forge = getForgeClient();
    const { siteUrl } = loadConfig();
    const detail = await forge.getSession(params.sessionId);

    if (!detail || !detail.sessionId) {
      return {
        content: [{ type: 'text', text: `❌ Session ${params.sessionId} not found.` }],
        isError: true,
      };
    }

    const links = detail.links || [];
    const linkStr = links.length > 0
      ? links.map((l) => {
          const u = browseUrl(siteUrl, l.issueKey);
          return u ? `[${l.issueKey}](${u}) (${l.context})` : `${l.issueKey} (${l.context})`;
        }).join(', ')
      : 'None';

    return {
      content: [{
        type: 'text',
        text: `Session: ${detail.sessionId}\n` +
          `Project: ${detail.projectName}\n` +
          `Time: ${detail.startTime} ~ ${detail.endTime} (${detail.duration})\n` +
          `Summary: ${detail.summary}\n` +
          `Tokens: ${fmtToken(detail.tokenTotal)} (${fmtToken(detail.tokenInput)} in / ${fmtToken(detail.tokenOutput)} out)\n` +
          `Messages: ${detail.humanMessageCount} human, ${detail.assistantMessageCount} assistant\n` +
          `Files: ${detail.fileChangeCount} changes\n` +
          `Linked Issues: ${linkStr}`,
      }],
    };
  },

  jira_delete_session: async (params) => {
    const forge = getForgeClient();
    const result = await forge.deleteSession(params.sessionId);

    if (!result?.deleted) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to delete session ${params.sessionId}.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `✅ Session deleted: ${params.sessionId}`,
      }],
    };
  },

  /**
   * Back up ~/.claude/settings.json to the Forge Session Tracker. Secrets are
   * redacted locally (replaced with ***REDACTED***), then sha256 is computed
   * before upload. dryRun=true previews without uploading.
   */
  // ---- AI terminal (client) tools ----

  /**
   * Idempotently register/refresh the current AI terminal. clientId is derived
   * locally & deterministically (no secrets); metadata (OS/arch/version/IP) is
   * collected via node os and uploaded.
   */
  jira_register_client: async (params) => {
    try {
      const forge = getForgeClient();
      const a = adapterFor(params);
      const { clientId, metadata, register } = await ensureClientRegistered(forge, a);
      const cloneWarn = register.cloneSuspect
        ? '\n⚠️ Possible clone (significantly different source seen within a short window) — consider whether this should be a separate terminal.'
        : '';
      return {
        content: [{
          type: 'text',
          text: `✅ AI terminal ${register.created ? 'registered' : 'refreshed'}\n` +
            `clientId: ${clientId}\n` +
            `Display name: ${metadata.displayName}\n` +
            `Host: ${metadata.hostname} (${metadata.osType}/${metadata.arch}, ${metadata.osVersion})\n` +
            `IP: ${metadata.ipAddress || '(not collected)'}\n` +
            `Version: ${metadata.clientVersion}\n` +
            `First seen: ${register.firstSeenAt}\n` +
            `Last seen: ${register.lastSeenAt}` +
            cloneWarn,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE' ? `\nPlease re-run ${setupHint()} to refresh the OAuth token.` : '';
      return { content: [{ type: 'text', text: `❌ Failed to register terminal: ${err.message}${hint}` }], isError: true };
    }
  },

  jira_list_clients: async (params) => {
    const forge = getForgeClient();
    const result = await forge.listClients();
    const clients = result.clients || [];
    if (clients.length === 0) {
      return { content: [{ type: 'text', text: 'No AI terminals registered yet. Run jira_register_client to register this terminal.' }] };
    }

    const currentId = currentClientId(adapterFor(params));

    const cols = ['#', 'Terminal', 'OS', 'Version', 'Last Seen', 'Client ID'];
    const rows = clients.map((c, i) => [
      String(i + 1),
      (c.clientId === currentId ? '➤ ' : '') + (c.displayName || c.hostname || '?') + (c.cloneSuspect ? ' ⚠️' : ''),
      `${c.osType || '?'}/${c.arch || '?'} ${c.osVersion || ''}`.trim(),
      c.clientVersion || '?',
      fmtTime(c.lastSeenAt),
      c.clientId,
    ]);
    const text = `Found ${clients.length} AI terminal(s):\n\n` + renderTable(cols, rows) +
      (currentId ? `\n\n➤ = current terminal` : '');
    return { content: [{ type: 'text', text }] };
  },

  jira_get_client: async (params) => {
    const forge = getForgeClient();
    let clientId = params.clientId;
    if (!clientId) {
      clientId = currentClientId(adapterFor(params));
    }
    if (!clientId) {
      return { content: [{ type: 'text', text: '❌ No clientId provided and the current terminal could not be resolved.' }], isError: true };
    }
    const result = await forge.getClient(clientId);
    const c = result.client;
    if (!c) {
      return { content: [{ type: 'text', text: `❌ Terminal ${clientId} not found.` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: `AI terminal: ${c.displayName}\n` +
          `clientId: ${c.clientId}\n` +
          `Type: ${c.clientType}\n` +
          `Host: ${c.hostname} (${c.osType}/${c.arch}, ${c.osVersion})\n` +
          `OS user: ${c.osUsername}\n` +
          `IP: ${c.ipAddress || '(not collected)'}\n` +
          `Version: ${c.clientVersion}${c.cloneSuspect === 'true' ? '  ⚠️ possible clone' : ''}\n` +
          `First/last seen: ${c.firstSeenAt} ~ ${c.lastSeenAt}`,
      }],
    };
  },

  jira_backup_user_settings: async (params) => {
    // 1. Read local settings.json
    let localSettings;
    try {
      localSettings = await loadLocalSettings();
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to read settings.json: ${err.message}` }],
        isError: true,
      };
    }

    if (!localSettings.exists) {
      return {
        content: [{
          type: 'text',
          text: `❌ ~/.claude/settings.json not found\n` +
            `This file is created by Claude Code on first configuration — make sure Claude Code is installed correctly.`,
        }],
        isError: true,
      };
    }

    // 2. Redact secrets + compute checksum
    const { sanitized, redactedKeys } = redactSecrets(localSettings.json);
    const content = JSON.stringify(sanitized);
    const checksum = checksumOf(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const topLevelKeys = Object.keys(sanitized);

    // 3. dryRun mode: show preview, do not upload
    if (params.dryRun) {
      const redactedInfo = redactedKeys.length > 0
        ? `Redacted keys (${redactedKeys.length}):\n${redactedKeys.map((k) => `  - ${k}`).join('\n')}`
        : 'No secrets redacted (no likely-secret fields detected in the file)';

      return {
        content: [{
          type: 'text',
          text: `🔍 Dry-run preview (not uploaded)\n\n` +
            `File: ${localSettings.path}\n` +
            `Top-level keys to back up (${topLevelKeys.length}): ${topLevelKeys.join(', ')}\n` +
            `Upload size: ${sizeBytes} bytes\n` +
            `SHA256: ${checksum}\n\n` +
            redactedInfo,
        }],
      };
    }

    // 4. Register this terminal (idempotent), then upload attributed to its clientId
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge);
      const result = await forge.backupUserSettings({
        content,
        checksum,
        scope: 'user',
        schemaVersion: '1',
        agent: 'claude',
        clientId,
      });

      // 5. Build response text
      const redactedSummary = redactedKeys.length > 0
        ? `\nRedacted keys (${redactedKeys.length}): ${redactedKeys.join(', ')}`
        : '\n(no fields redacted)';
      const terminalLine = `\nTerminal: ${result.clientId || clientId}`;

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ Settings unchanged (identical to this terminal's stored backup, no update needed)\n` +
              `Owner: ${result.ownerAccountId}` +
              terminalLine + `\n` +
              `Current version: r${result.revision}\n` +
              `Last backed up: ${result.backedUpAt}` +
              redactedSummary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ Settings backed up to Forge Session Tracker\n` +
            `Owner: ${result.ownerAccountId}` +
            terminalLine + `\n` +
            `Version: r${result.revision}\n` +
            `Size: ${result.sizeBytes ?? sizeBytes} bytes\n` +
            `Backed up at: ${result.backedUpAt}` +
            redactedSummary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? `\nPlease re-run ${setupHint()} to refresh the OAuth token.`
        : '';
      return {
        content: [{
          type: 'text',
          text: `❌ Backup failed: ${err.message}${hint}`,
        }],
        isError: true,
      };
    }
  },

  /**
   * Back up ~/.claude.json (global state / account / user-scope MCP) to the Forge
   * Session Tracker. Slimmed locally first (slimClaudeJson: strips cache/stats/
   * projects), then redacted (redactSecrets: primaryApiKey, mcpServers.*.env keys,
   * etc. replaced with ***REDACTED***), then sha256 is computed before upload.
   * dryRun=true previews without uploading.
   */
  jira_backup_claude_config: async (params) => {
    // 1. Read local ~/.claude.json
    let local;
    try {
      local = await loadClaudeJson();
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to read .claude.json: ${err.message}` }],
        isError: true,
      };
    }

    if (!local.exists) {
      return {
        content: [{
          type: 'text',
          text: `❌ ~/.claude.json not found\n` +
            `This file is created by Claude Code on first run — make sure Claude Code is installed and has been started.`,
        }],
        isError: true,
      };
    }

    // 2. Slim → redact → compute checksum
    const { slimmed, removedKeys } = slimClaudeJson(local.json);
    const { sanitized, redactedKeys } = redactSecrets(slimmed);
    const content = JSON.stringify(sanitized);
    const checksum = checksumOf(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const topLevelKeys = Object.keys(sanitized);

    // 3. dryRun mode: show preview, do not upload
    if (params.dryRun) {
      const removedInfo = removedKeys.length > 0
        ? `Stripped top-level keys (${removedKeys.length}, cache/stats/projects): ${removedKeys.join(', ')}`
        : 'No fields stripped';
      const redactedInfo = redactedKeys.length > 0
        ? `Redacted keys (${redactedKeys.length}):\n${redactedKeys.map((k) => `  - ${k}`).join('\n')}`
        : 'No secrets redacted (no likely-secret fields detected)';

      return {
        content: [{
          type: 'text',
          text: `🔍 Dry-run preview (not uploaded)\n\n` +
            `File: ${local.path}\n` +
            `Top-level keys to back up (${topLevelKeys.length}): ${topLevelKeys.join(', ')}\n` +
            `Upload size: ${sizeBytes} bytes\n` +
            `SHA256: ${checksum}\n\n` +
            `${removedInfo}\n\n` +
            redactedInfo,
        }],
      };
    }

    // 4. Register this terminal (idempotent), then upload attributed to its clientId
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge);
      const result = await forge.backupClaudeConfig({
        content,
        checksum,
        scope: 'user',
        schemaVersion: '1',
        agent: 'claude',
        clientId,
      });

      const terminalLine = `\nTerminal: ${result.clientId || clientId}`;
      const summary =
        `\nStripped top-level keys: ${removedKeys.length} (cache/stats/projects)` +
        (redactedKeys.length > 0
          ? `\nRedacted keys (${redactedKeys.length}): ${redactedKeys.join(', ')}`
          : '\n(no fields redacted)');

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ .claude.json unchanged (identical to this terminal's stored backup, no update needed)\n` +
              `Owner: ${result.ownerAccountId}` +
              terminalLine + `\n` +
              `Current version: r${result.revision}\n` +
              `Last backed up: ${result.backedUpAt}` +
              summary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ .claude.json backed up to Forge Session Tracker\n` +
            `Owner: ${result.ownerAccountId}` +
            terminalLine + `\n` +
            `Version: r${result.revision}\n` +
            `Size: ${result.sizeBytes ?? sizeBytes} bytes\n` +
            `Backed up at: ${result.backedUpAt}` +
            summary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? `\nPlease re-run ${setupHint()} to refresh the OAuth token.`
        : '';
      return {
        content: [{
          type: 'text',
          text: `❌ Backup failed: ${err.message}${hint}`,
        }],
        isError: true,
      };
    }
  },
  /**
   * Back up ~/.codex/config.toml to the Forge Session Tracker. Redacted locally
   * line-by-line (redactTomlSecrets: quoted-string assignments whose key looks
   * like a secret are replaced with <REDACTED>, covering both standalone and
   * [mcp_servers.*.env] inline-table entries), then sha256 is computed before
   * upload. Ownership is forced to the codex terminal (regardless of which agent
   * this MCP server runs under) — it backs up the Codex config. dryRun=true
   * previews without uploading.
   */
  jira_backup_codex_config: async (params) => {
    // 1. Read local ~/.codex/config.toml
    let local;
    try {
      local = await loadCodexConfig();
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to read config.toml: ${err.message}` }],
        isError: true,
      };
    }

    if (!local.exists) {
      return {
        content: [{
          type: 'text',
          text: `❌ ~/.codex/config.toml not found\n` +
            `This file is created by Codex CLI — make sure Codex is installed and has been run (override the path with $CODEX_HOME).`,
        }],
        isError: true,
      };
    }

    // 2. Redact → compute checksum (keep raw TOML text, do not parse)
    const { sanitized, redactedKeys } = redactTomlSecrets(local.text);
    const content = sanitized;
    const checksum = checksumOf(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // 3. dryRun mode: show preview, do not upload
    if (params.dryRun) {
      const redactedInfo = redactedKeys.length > 0
        ? `Redacted keys (${redactedKeys.length}):\n${redactedKeys.map((k) => `  - ${k}`).join('\n')}`
        : 'No secrets redacted (no likely-secret fields detected)';

      return {
        content: [{
          type: 'text',
          text: `🔍 Dry-run preview (not uploaded)\n\n` +
            `File: ${local.path}\n` +
            `Upload size: ${sizeBytes} bytes\n` +
            `SHA256: ${checksum}\n\n` +
            redactedInfo,
        }],
      };
    }

    // 4. Register the Codex terminal (forced codex ownership), then upload by clientId
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge, getAdapter('codex'));
      const result = await forge.backupCodexConfig({
        content,
        checksum,
        scope: 'user',
        schemaVersion: '1',
        agent: 'codex',
        clientId,
      });

      const terminalLine = `\nTerminal: ${result.clientId || clientId}`;
      const summary = redactedKeys.length > 0
        ? `\nRedacted keys (${redactedKeys.length}): ${redactedKeys.join(', ')}`
        : '\n(no fields redacted)';

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ config.toml unchanged (identical to this terminal's stored backup, no update needed)\n` +
              `Owner: ${result.ownerAccountId}` +
              terminalLine + `\n` +
              `Current version: r${result.revision}\n` +
              `Last backed up: ${result.backedUpAt}` +
              summary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ config.toml backed up to Forge Session Tracker\n` +
            `Owner: ${result.ownerAccountId}` +
            terminalLine + `\n` +
            `Version: r${result.revision}\n` +
            `Size: ${result.sizeBytes ?? sizeBytes} bytes\n` +
            `Backed up at: ${result.backedUpAt}` +
            summary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? `\nPlease re-run ${setupHint()} to refresh the OAuth token.`
        : '';
      return {
        content: [{
          type: 'text',
          text: `❌ Backup failed: ${err.message}${hint}`,
        }],
        isError: true,
      };
    }
  },

  /**
   * 统一备份 Codex（~/.codex）的全部类别到 Forge Session Tracker（APDEVIMP-83）。
   * 本地按类采集（collectCodexBackup，含 TOML/JSON/文本三种脱敏）→ 一次上传，服务端
   * 逐类存为独立 blob（每类独立 checksum，未变短路）。dryRun=true 仅预览不上传。
   */
  jira_backup_codex: async (params) => {
    // 1. Collect per-category (redaction happens inside the collector).
    let backup;
    try {
      backup = collectCodexBackup();
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Failed to collect Codex backup: ${err.message}` }],
        isError: true,
      };
    }

    const CATEGORY_LABELS = {
      config: 'config.toml',
      guidance: 'AGENTS.md',
      hooks: 'hooks.json',
      agents: 'agents/',
      skills: 'skills/',
      rules: 'rules/',
      'local-memory': 'memories/',
    };
    const ORDER = ['config', 'guidance', 'hooks', 'agents', 'skills', 'rules', 'local-memory'];

    const present = ORDER.map((name) => backup.categories[name]).filter((c) => c && c.present);
    if (present.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ Nothing to back up — no Codex config or assets found under ~/.codex (override the path with $CODEX_HOME).`,
        }],
      };
    }

    // Optional selection: back up only the requested categories (each is a
    // separate blob, so unselected ones are simply left untouched). Omit → all.
    const requested = Array.isArray(params.categories) && params.categories.length
      ? new Set(params.categories)
      : null;
    const selected = requested ? present.filter((c) => requested.has(c.category)) : present;
    if (selected.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ None of the selected categories are present under ~/.codex. Available: ${present.map((c) => c.category).join(', ')}.`,
        }],
      };
    }
    const deselected = present.filter((c) => !selected.includes(c));

    // 2. Build upload payload + preview lines.
    const uploadCategories = [];
    const previewLines = [];
    for (const c of selected) {
      const label = CATEGORY_LABELS[c.category] || c.category;
      if (c.kind === 'single') {
        uploadCategories.push({ category: c.category, kind: 'single', checksum: c.checksum, content: c.content });
        previewLines.push(`  • ${label} — ${c.sizeBytes} bytes, ${c.redactedCount} redacted`);
      } else {
        uploadCategories.push({
          category: c.category, kind: 'multi', checksum: c.checksum,
          bundle: c.bundle, manifest: c.manifest, fileCount: c.fileCount,
        });
        previewLines.push(`  • ${label} — ${c.fileCount} files, ${c.totalBytes} bytes, ${c.redactedTotal} redacted, ${c.skipped.length} skipped`);
      }
    }
    const absent = ORDER.filter((n) => !backup.categories[n]?.present);

    // 3. dryRun mode: preview, do not upload.
    if (params.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `🔍 Dry-run preview (not uploaded)\n\n` +
            `Categories to back up (${selected.length}):\n${previewLines.join('\n')}\n\n` +
            (deselected.length ? `Present but NOT selected: ${deselected.map((c) => c.category).join(', ')}\n` : '') +
            (absent.length ? `Not present (skipped): ${absent.join(', ')}\n` : '') +
            `\nSecrets are redacted locally before upload; the root memories_*.sqlite cache and auth.json are never sent.`,
        }],
      };
    }

    // 4. Register the Codex terminal (forced codex ownership), then upload all categories at once.
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge, getAdapter('codex'));
      const result = await forge.backupCodex({ clientId, agent: 'codex', categories: uploadCategories });

      const results = result.results || {};
      const lines = ORDER.filter((n) => results[n]).map((n) => {
        const r = results[n];
        const label = CATEGORY_LABELS[n] || n;
        if (r.error) return `  ❌ ${label} — ${r.message || r.error}`;
        if (r.unchanged) return `  ➖ ${label} — unchanged (r${r.revision})`;
        return `  ${r.created ? '✅' : '🔄'} ${label} — ${r.created ? 'created' : 'updated'} r${r.revision}`;
      });

      return {
        content: [{
          type: 'text',
          text: `✅ Codex backup uploaded to Forge Session Tracker\n` +
            `Owner: ${result.ownerAccountId}\nTerminal: ${result.clientId || clientId}\n\n` +
            lines.join('\n'),
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? `\nPlease re-run ${setupHint()} to refresh the OAuth token.`
        : '';
      return {
        content: [{ type: 'text', text: `❌ Backup failed: ${err.message}${hint}` }],
        isError: true,
      };
    }
  },

  /**
   * 备份 ~/.claude 自定义资产（CLAUDE.md / rules / agents / commands / skills /
   * output-styles / keybindings + 树内引用脚本）到 Forge Session Tracker。
   * 本地遍历采集 → 脱敏（JSON 键级 redactSecrets + 自由文本/脚本值级 scanTextSecrets）
   * → 打包 bundle + manifest → 计算去重 checksum → 注册终端后按 clientId 上传。
   * dryRun=true 时仅预览不上传。
   */
  jira_backup_resources: async (params) => {
    // PARTIAL backup: a non-empty categories[] collects only those sub-groups
    // (scripts always rides along) and triggers a server-side MERGE that
    // preserves the unselected categories' existing backup.
    const categories = Array.isArray(params.categories) && params.categories.length > 0
      ? params.categories
      : undefined;

    // 1. 采集本地资产（遍历 + 脱敏 + 打包）
    let collected;
    try {
      collected = collectResources({ categories });
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ 采集资源失败: ${err.message}` }],
        isError: true,
      };
    }

    const { bundle, manifest, checksum, fileCount, byCategory, redactions, redactedTotal, skipped } = collected;
    const sizeBytes = Buffer.byteLength(bundle, 'utf8');
    const skippedSummary = summarizeSkipped(skipped);

    // 无资产可备份（非错误，给出提示）
    if (fileCount === 0) {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ 未在 ~/.claude 下找到可备份的自定义资产\n` +
            `（rules / agents / commands / skills / output-styles / keybindings；记忆文件请用 /jira-backup-claude）。` +
            (skipped.length ? `\n\n${skippedSummary}` : ''),
        }],
      };
    }

    const categoryLine = Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(', ');
    const redactedInfo = redactedTotal > 0
      ? `脱敏内联密钥: 共 ${redactedTotal} 处\n${redactions.map((r) => `  - ${r.relPath}: ${r.count}`).join('\n')}`
      : '未检测到内联密钥（无脱敏）';

    // 备份范围标注：部分类目（merge，未选类目保留）vs 全量。scripts 恒随行。
    const scopeLine = categories
      ? `范围: 部分子分组 [${categories.join(', ')}]（scripts 随行；未选子分组在 Jira 端保留 / merge）`
      : `范围: 全部资源（整包替换）`;

    // 2. dryRun 预览
    if (params.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `🔍 干跑预览（不上传）\n\n` +
            `资产根目录: ~/.claude\n` +
            `${scopeLine}\n` +
            `将备份文件: ${fileCount} 个，共 ${sizeBytes} 字节\n` +
            `分类（子分组分解）: ${categoryLine}\n` +
            `SHA256(去重): ${checksum}\n\n` +
            redactedInfo +
            (skipped.length ? `\n\n${skippedSummary}` : ''),
        }],
      };
    }

    // 3. 注册当前终端（幂等）后按 clientId 归属上传
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge);
      const result = await forge.backupResources({
        content: bundle,
        manifest,
        fileCount,
        checksum,
        scope: 'user',
        schemaVersion: '1',
        agent: 'claude',
        clientId,
        // Partial backup → server merges (preserves unselected categories).
        ...(categories ? { categories } : {}),
      });

      const terminalLine = `\n终端: ${result.clientId || clientId}`;
      const summary =
        `\n${scopeLine}` +
        `\n分类: ${categoryLine}` +
        (redactedTotal > 0 ? `\n脱敏内联密钥: ${redactedTotal} 处` : '\n（无内联密钥被脱敏）') +
        (skipped.length ? `\n跳过: ${skipped.length} 个（含 out-of-tree 引用脚本等）` : '');

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ 资源未变化（与该终端已备份版本相同，无需更新）\n` +
              `属主: ${result.ownerAccountId}` +
              terminalLine + `\n` +
              `当前版本: r${result.revision}\n` +
              `最后备份: ${result.backedUpAt}` +
              summary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ 资源已备份到 Forge Session Tracker\n` +
            `属主: ${result.ownerAccountId}` +
            terminalLine + `\n` +
            `版本: r${result.revision}\n` +
            `文件数: ${result.fileCount ?? fileCount}\n` +
            `大小: ${result.sizeBytes ?? sizeBytes} 字节\n` +
            `备份时间: ${result.backedUpAt}` +
            summary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? '\n请重新运行 /jira-setup 以刷新 OAuth 令牌。'
        : '';
      return {
        content: [{ type: 'text', text: `❌ 备份失败: ${err.message}${hint}` }],
        isError: true,
      };
    }
  },

  /**
   * 备份 Claude Code 记忆（用户记忆 ~/.claude/CLAUDE.md + 项目自动记忆
   * projects/<proj>/memory/ + Agent 自动记忆 agent-memory/<agentType>/）到 Forge
   * Session Tracker。本地遍历采集 → 客户端脱敏 → 打包 bundle + manifest（含 group
   * 分组）→ 计算去重 checksum → 注册终端后按 clientId 上传。dryRun=true 时仅预览。
   * 会话 transcript 与 session-memory 属「会话历史」，不在本工具范围。
   */
  jira_backup_memory: async (params) => {
    // 1. 采集本地记忆（遍历 + 脱敏 + 打包）
    let collected;
    try {
      collected = collectMemory();
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ 采集记忆失败: ${err.message}` }],
        isError: true,
      };
    }

    const { bundle, manifest, checksum, fileCount, byCategory, byGroup, redactions, redactedTotal, skipped } = collected;
    const sizeBytes = Buffer.byteLength(bundle, 'utf8');
    const scopeOptional = (skipped || []).filter((s) => s.reason === 'scope-optional');
    const scopeHint = scopeOptional.length
      ? `作用域提示：检测到 ${scopeOptional.length} 处 project/local 作用域 agent-memory（通常随 git 或为本机私有，默认不纳入）:\n` +
        scopeOptional.map((s) => `  - ${s.relPath}`).join('\n')
      : '';

    // 无记忆可备份（非错误，给出提示）
    if (fileCount === 0) {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ 未在 ~/.claude 下找到可备份的记忆\n` +
            `（用户记忆 CLAUDE.md / 项目自动记忆 projects/<proj>/memory/ / Agent 自动记忆 agent-memory/<agentType>/）。` +
            (scopeHint ? `\n\n${scopeHint}` : ''),
        }],
      };
    }

    const categoryLine = Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(', ');
    const groupInfo = summarizeMemoryGroups(byGroup);
    const redactedInfo = redactedTotal > 0
      ? `脱敏内联密钥: 共 ${redactedTotal} 处\n${redactions.map((r) => `  - ${r.relPath}: ${r.count}`).join('\n')}`
      : '未检测到内联密钥（无脱敏）';

    // 2. dryRun 预览
    if (params.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `🔍 干跑预览（不上传）\n\n` +
            `记忆根目录: ~/.claude\n` +
            `将备份文件: ${fileCount} 个，共 ${sizeBytes} 字节\n` +
            `分类: ${categoryLine}\n` +
            (groupInfo ? `${groupInfo}\n` : '') +
            `SHA256(去重): ${checksum}\n\n` +
            redactedInfo +
            (scopeHint ? `\n\n${scopeHint}` : ''),
        }],
      };
    }

    // 3. 注册当前终端（幂等）后按 clientId 归属上传
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge);
      const result = await forge.backupMemory({
        content: bundle,
        manifest,
        fileCount,
        checksum,
        scope: 'user',
        schemaVersion: '1',
        agent: 'claude',
        clientId,
      });

      const terminalLine = `\n终端: ${result.clientId || clientId}`;
      const summary =
        `\n分类: ${categoryLine}` +
        (redactedTotal > 0 ? `\n脱敏内联密钥: ${redactedTotal} 处` : '\n（无内联密钥被脱敏）') +
        (scopeOptional.length ? `\n作用域提示: ${scopeOptional.length} 处 project/local agent-memory 未纳入` : '');

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ 记忆未变化（与该终端已备份版本相同，无需更新）\n` +
              `属主: ${result.ownerAccountId}` +
              terminalLine + `\n` +
              `当前版本: r${result.revision}\n` +
              `最后备份: ${result.backedUpAt}` +
              summary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ 记忆已备份到 Forge Session Tracker\n` +
            `属主: ${result.ownerAccountId}` +
            terminalLine + `\n` +
            `版本: r${result.revision}\n` +
            `文件数: ${result.fileCount ?? fileCount}\n` +
            `大小: ${result.sizeBytes ?? sizeBytes} 字节\n` +
            `备份时间: ${result.backedUpAt}` +
            summary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE'
        ? '\n请重新运行 /jira-setup 以刷新 OAuth 令牌。'
        : '';
      return {
        content: [{ type: 'text', text: `❌ 备份失败: ${err.message}${hint}` }],
        isError: true,
      };
    }
  },

  /**
   * 备份 ~/.claude/plugins 的两份清单（installed_plugins.json + known_marketplaces.json）
   * 到 Forge Session Tracker。仅读取这两份具名文件；cache/repos/marketplaces/data、
   * plugin-catalog-cache.json、*.bak 据清单可重建，不备份。规范化 + 去重 checksum 后按
   * clientId 上传。dryRun=true 时仅预览不上传。
   */
  jira_backup_plugins: async (params) => {
    // 1. 采集本机插件/市场清单
    let collected;
    try {
      collected = collectPlugins();
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ 读取插件清单失败: ${err.message}` }], isError: true };
    }

    const { content, checksum, pluginCount, marketplaceCount, redactedKeys, files, excluded, present } = collected;
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // 两份清单都不存在 → 无可备份（非错误，给出提示）
    if (!present) {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ 未在 ~/.claude/plugins 下找到 installed_plugins.json 或 known_marketplaces.json\n` +
            `（尚未安装任何插件/市场，或使用了非默认插件目录）。`,
        }],
      };
    }

    const filesLine = files.map((f) => `${f.name}${f.exists ? ` (${f.sizeBytes}B)` : '（缺失）'}`).join(', ');
    const excludedLine = `据清单可重建，故不备份: ${excluded.join(', ')}`;
    const redactedLine = redactedKeys.length
      ? `脱敏键（${redactedKeys.length} 个）: ${redactedKeys.join(', ')}`
      : '（无字段被脱敏）';

    // 2. dryRun 预览
    if (params.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `🔍 干跑预览（不上传）\n\n` +
            `插件目录: ~/.claude/plugins\n` +
            `将备份: ${filesLine}\n` +
            `已装插件: ${pluginCount} 个，市场源: ${marketplaceCount} 个\n` +
            `上传大小: ${sizeBytes} 字节\n` +
            `SHA256(去重): ${checksum}\n\n` +
            `${excludedLine}\n\n` +
            redactedLine,
        }],
      };
    }

    // 3. 注册当前终端（幂等）后按 clientId 归属上传
    try {
      const forge = getForgeClient();
      const { clientId } = await ensureClientRegistered(forge);
      const result = await forge.backupPlugins({
        content,
        checksum,
        pluginCount,
        marketplaceCount,
        scope: 'user',
        schemaVersion: '1',
        agent: 'claude',
        clientId,
      });

      const terminalLine = `\n终端: ${result.clientId || clientId}`;
      const summary = `\n已装插件: ${pluginCount} 个，市场源: ${marketplaceCount} 个\n${excludedLine}`;

      if (result.unchanged) {
        return {
          content: [{
            type: 'text',
            text: `✅ 插件/市场清单未变化（与该终端已备份版本相同，无需更新）\n` +
              `属主: ${result.ownerAccountId}` + terminalLine + `\n` +
              `当前版本: r${result.revision}\n` +
              `最后备份: ${result.backedUpAt}` +
              summary,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ 插件/市场清单已备份到 Forge Session Tracker\n` +
            `属主: ${result.ownerAccountId}` + terminalLine + `\n` +
            `版本: r${result.revision}\n` +
            `大小: ${result.sizeBytes ?? sizeBytes} 字节\n` +
            `备份时间: ${result.backedUpAt}` +
            summary,
        }],
      };
    } catch (err) {
      const hint = err.code === 'REGENERATE' ? '\n请重新运行 /jira-setup 以刷新 OAuth 令牌。' : '';
      return { content: [{ type: 'text', text: `❌ 备份失败: ${err.message}${hint}` }], isError: true };
    }
  },
};

// ---------------------------------------------------------------------------
// Forge helper functions
// ---------------------------------------------------------------------------

/**
 * Resolve the restore target directory under ~/.claude/projects/.
 *
 * The target is the CURRENT Claude Code working directory (process.cwd()),
 * NOT the original machine's path stored in projectName. This way a restored
 * session lands where the user is actually working now — so `claude --resume`
 * (run from this project) finds it, and cross-machine restore doesn't create
 * a foreign-path-named directory.
 *
 * Claude Code encodes paths by replacing '/' with '-':
 *   /Users/yinliang/Workspace/AI/ai-co-work → -Users-yinliang-Workspace-AI-ai-co-work
 *
 * @param projectName - Stored origin path key (fallback if cwd unavailable)
 */
function findOrCreateProjectDir(projectsDir, projectName) {
  try {
    // Primary: restore into the current Claude Code project directory.
    const cwdEncoded = process.cwd().replace(/[\\/:]/g, '-');
    if (cwdEncoded && cwdEncoded !== '-' && cwdEncoded !== process.env.HOME?.replace(/[\\/:]/g, '-')) {
      const cwdDir = join(projectsDir, cwdEncoded);
      mkdirSync(cwdDir, { recursive: true });
      return cwdDir;
    }

    // Fallback: use the stored origin project key (create if missing).
    const encoded = (projectName || '').replace(/[\\/:]/g, '-');
    if (encoded) {
      const dir = join(projectsDir, encoded);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function fmtToken(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Sort sessions most-recent-first by endTime (last activity),
 * falling back to startTime, then linkedAt.
 */
function sortByRecency(sessions) {
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.endTime || a.startTime || a.linkedAt || '') || 0;
    const tb = Date.parse(b.endTime || b.startTime || b.linkedAt || '') || 0;
    return tb - ta;
  });
}

/**
 * Format an ISO timestamp as a short local-style string: 2026-06-13 04:35
 */
function fmtTime(iso) {
  if (!iso) return '?';
  return iso.replace('T', ' ').slice(0, 16);
}

/**
 * Truncate a string to n chars, collapsing whitespace and escaping pipes.
 */
function truncate(s, n) {
  const clean = (s || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

/**
 * Extract the first real user prompt from a Claude JSONL transcript, skipping
 * slash-command boilerplate (<local-command-caveat> / <command-*> wrappers).
 * FALLBACK cue for the /resume hint when the session has no `ai-title` line yet
 * (extractAiTitle in lib/ai-title.mjs is the primary, exact cue). Claude Code
 * derives its picker title from the first prompt, so the topic matches even
 * though the wording differs.
 */
function firstUserPrompt(jsonl) {
  if (!jsonl) return '';
  for (const raw of jsonl.split('\n')) {
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (!o || o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const txt = (typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.map(b => (b && b.text) || '').join('') : ''
    ).trim();
    if (!txt || txt.startsWith('<local-command-caveat') || txt.startsWith('<command-')) continue;
    return txt.replace(/\s+/g, ' ');
  }
  return '';
}

/**
 * Derive a clean, short project label for display.
 * Prefers the basename of the real cwd path (projectPath); falls back to the
 * encoded projectName key for old sessions that predate projectPath.
 */
function projectLabel(s) {
  if (s.projectPath) {
    const base = s.projectPath.replace(/\/+$/, '').split('/').pop();
    if (base) return base;
  }
  // Fallback: encoded key (e.g. -Users-x-Workspace-ai-co-work) — show as-is
  return s.projectName || '?';
}

/**
 * Summarize skipped resource entries for backup output: counts by reason, and
 * the explicit out-of-tree referenced-script paths (a known limitation worth
 * surfacing so the user can move those scripts under ~/.claude).
 */
function summarizeSkipped(skipped) {
  if (!skipped || skipped.length === 0) return '';
  const byReason = {};
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  const counts = Object.entries(byReason).map(([r, n]) => `${r}:${n}`).join(', ');
  let text = `跳过 ${skipped.length} 个文件（${counts}）`;
  const outOfTree = skipped.filter((s) => s.reason === 'out-of-tree').map((s) => `  - ${s.relPath}`);
  if (outOfTree.length) {
    text += `\n树外引用脚本（未备份，已知限制）:\n${outOfTree.join('\n')}`;
  }
  return text;
}

/**
 * Summarize memory byGroup for backup output: project-memory grouped by project
 * and agent-memory grouped by agentType, e.g.
 *   项目自动记忆分组: -Users-me-projA:2, -Users-me-projB:1
 *   Agent 自动记忆分组: architect:2, reviewer:1
 */
function summarizeMemoryGroups(byGroup) {
  if (!byGroup) return '';
  const labels = { 'project-memory': '项目自动记忆分组', 'agent-memory': 'Agent 自动记忆分组' };
  const lines = [];
  for (const [category, label] of Object.entries(labels)) {
    const groups = byGroup[category];
    if (!groups || Object.keys(groups).length === 0) continue;
    const parts = Object.entries(groups).map(([g, n]) => `${g}:${n}`).join(', ');
    lines.push(`${label}: ${parts}`);
  }
  return lines.join('\n');
}

/**
 * Render an array of rows as a GitHub-flavored markdown table.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function renderTable(headers, rows) {
  const esc = (c) => String(c).replace(/\|/g, '\\|');
  const line = (cells) => '| ' + cells.map(esc).join(' | ') + ' |';
  const sep = '|' + headers.map(() => '---').join('|') + '|';
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// MCP Server main loop (stdio)
// ---------------------------------------------------------------------------

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue;
    handleLine(line);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) handleLine(buffer);
});

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Ignore unparseable lines
  }

  const { id, method, params } = msg;
  // id can be 0 (valid JSON-RPC), so check null/undefined explicitly
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'agentry-for-jira',
            version: '1.0.0',
          },
        });
        break;

      case 'notifications/initialized':
        // Client confirmed initialization, no response needed
        break;

      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        break;

      case 'tools/call': {
        const toolName = params?.name;
        const toolParams = params?.arguments || {};

        // Check configuration (web trigger URL present)
        const configCheck = checkConfig();
        if (!configCheck.ok && toolName !== 'jira_test_connection') {
          sendResult(id, {
            content: [{ type: 'text', text: `❌ Jira session-sync not configured. Set via ${setupHint()} (missing: ${configCheck.missing.join(', ')}).` }],
            isError: true,
          });
          break;
        }

        const handler = handlers[toolName];
        if (!handler) {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          break;
        }

        try {
          const result = await handler(toolParams);
          sendResult(id, result);
        } catch (err) {
          // localizeSetupHint rewrites /jira-setup → $jira-setup under Codex for
          // messages that originate in the agent-agnostic lib layer.
          const errorMsg = localizeSetupHint(
            err instanceof ConfigError
              ? `❌ Configuration error: ${err.message}`
              : `❌ Error: ${err.message}`
          );
          sendResult(id, {
            content: [{ type: 'text', text: errorMsg }],
            isError: true,
          });
        }
        break;
      }

      case 'ping':
        sendResult(id, {});
        break;

      default:
        // Ignore unknown methods
        break;
    }
  } catch (err) {
    if (id) sendError(id, -32603, `Internal error: ${err.message}`);
  }
}
