/**
 * restore-target.mjs — decide where a restored session file lands locally.
 *
 * Pure + injectable so the path logic is unit-testable without touching the
 * real filesystem. The MCP `jira_restore_session` tool calls this after reading
 * the session's `agent` from the server — restore is driven by the SESSION's
 * agent (so a Codex session restored from anywhere lands under ~/.codex/sessions
 * where `codex resume` can find it), not by whichever agent hosts the MCP server.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the local restore target for a Codex session.
 *
 * Codex stores rollouts under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
 * (date dirs are organizational — `codex resume <id>` scans all of them and
 * matches the thread_id in the file's first session_meta line, so the filename
 * only needs to be unique + end in .jsonl).
 *
 * @param {string} sessionId - Codex thread_id (used in the filename).
 * @param {object} [opts]
 * @param {string} [opts.codexHome] - Override $CODEX_HOME (tests).
 * @param {Date}   [opts.now]       - Override the current date (tests).
 * @returns {{dir: string, fileName: string, targetPath: string, resumeCmd: string}}
 */
export function resolveCodexRestorePath(sessionId, opts = {}) {
  const codexHome =
    opts.codexHome !== undefined
      ? opts.codexHome
      : process.env.CODEX_HOME || join(homedir(), '.codex');
  const d = opts.now || new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dir = join(codexHome, 'sessions', yyyy, mm, dd);
  const fileName = `rollout-${sessionId}.jsonl`;
  return {
    dir,
    fileName,
    targetPath: join(dir, fileName),
    resumeCmd: `codex resume ${sessionId}`,
  };
}
