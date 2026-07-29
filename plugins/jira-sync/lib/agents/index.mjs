/**
 * index.mjs — agent adapter dispatch.
 *
 * detectAgent(env) picks the adapter for the current process; the default is
 * 'claude' so existing Claude-only users see zero behavior change. MCP tools
 * can also override per-call via an explicit `agent` parameter (see
 * mcp-server/index.mjs).
 */
import { claudeAdapter } from './claude.mjs';
import { codexAdapter } from './codex.mjs';

export { claudeAdapter, codexAdapter };

/** @type {Record<string, import('./types.mjs').AgentAdapter>} */
const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

/**
 * Resolve an adapter by name.
 * @param {string} agent - 'claude' | 'codex'
 * @returns {import('./types.mjs').AgentAdapter}
 */
export function getAdapter(agent) {
  const a = ADAPTERS[agent];
  if (!a) throw new Error(`Unknown agent "${agent}". Supported: claude, codex.`);
  return a;
}

/**
 * Detect which agent the current process belongs to.
 *
 * Precedence:
 *   1. Explicit `JIRA_SYNC_AGENT` override ('codex' | 'claude').
 *   2. Host environment markers (CODEX_HOME/CODEX_VERSION → codex;
 *      CLAUDE_CODE_SESSION_ID/CLAUDE_CODE_VERSION → claude).
 *   3. Default 'claude' (preserves legacy behavior — the plugin was Claude-only).
 *
 * @param {Record<string,string>} [env]
 * @returns {'claude'|'codex'}
 */
export function detectAgent(env = process.env) {
  if (env.JIRA_SYNC_AGENT === 'codex') return 'codex';
  if (env.JIRA_SYNC_AGENT === 'claude') return 'claude';
  if (env.CODEX_HOME || env.CODEX_VERSION) return 'codex';
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_VERSION) return 'claude';
  return 'claude';
}
