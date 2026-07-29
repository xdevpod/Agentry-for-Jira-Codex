/**
 * codex-threads-register.mjs — register a restored/converted session in Codex's
 * session index so `codex resume <id>` can find and load it.
 *
 * Codex ≥0.128 keeps the resume picker index in a SQLite DB
 * ($CODEX_HOME/state_5.sqlite → table `threads`), NOT by scanning rollout files.
 * Writing the rollout file alone is NOT enough — the session is invisible to
 * `codex resume`. This module inserts/refreshes the row.
 *
 * `node:sqlite` is imported LAZILY inside the function so that:
 *   - the MCP server doesn't pay the import cost (or trigger its experimental
 *     warning) except on the codex-restore path, and
 *   - users on Node <22.5 only lose THIS feature (graceful per-call error),
 *     instead of crashing the whole MCP server at startup.
 *
 * Additive + idempotent: INSERT OR IGNORE by id. If a row already exists (e.g. a
 * real Codex-created thread on a machine that already has the session locally),
 * it is left untouched — so this never disturbs an existing Codex-only setup.
 * A row is added only when none exists (the new-machine case, where the rollout
 * file alone wouldn't be found by `codex resume`). See memory
 * `codex-rollout-cross-agent-handoff`.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Minimal threads schema covering exactly the columns we write. In production
 *  Codex has already created the FULL table (+ triggers); CREATE IF NOT EXISTS
 *  is then a no-op. This bootstrap only fires in tests / a fresh $CODEX_HOME. */
const BOOTSTRAP_THREADS = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  cli_version TEXT NOT NULL DEFAULT '',
  first_user_message TEXT NOT NULL DEFAULT '',
  thread_source TEXT,
  preview TEXT NOT NULL DEFAULT ''
)`;

const UPSERT_SQL = `
INSERT OR IGNORE INTO threads
  (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
   sandbox_policy, approval_mode, has_user_event, cli_version, first_user_message,
   thread_source, preview)
VALUES (?, ?, ?, ?, 'cli', ?, ?, ?, ?, 'on-request', 1, ?, ?, 'user', ?)`;

/**
 * Insert/refresh a Codex `threads` row for a restored session.
 *
 * @param {object} args
 * @param {string} args.sessionId     - Thread id (matches the rollout filename UUID
 *        + session_meta.session_id).
 * @param {string} args.rolloutPath   - Absolute path to the rollout .jsonl.
 * @param {string} args.cwd
 * @param {string} [args.title]       - First user message (for the picker).
 * @param {string} [args.preview]     - Short snippet; defaults to title. MUST be
 *        non-empty so the picker's `WHERE preview <> ''` index includes it.
 * @param {string} [args.modelProvider]
 * @param {string} [args.cliVersion]
 * @param {object} [opts]
 * @param {string} [opts.codexHome]   - Override $CODEX_HOME (tests).
 * @returns {Promise<{ registered: true, dbPath: string }>}
 */
export async function registerCodexThread(args, opts = {}) {
  const { sessionId, rolloutPath, cwd } = args;
  if (!sessionId || !rolloutPath) throw new Error('sessionId and rolloutPath are required');

  const { DatabaseSync } = await import('node:sqlite');
  const codexHome = opts.codexHome != null
    ? opts.codexHome
    : (process.env.CODEX_HOME || join(homedir(), '.codex'));
  const dbPath = join(codexHome, 'state_5.sqlite');

  const title = (args.title || '(bridged session)').slice(0, 80);
  const preview = (args.preview || args.title || '(bridged session)').slice(0, 200);
  const sec = Math.floor(Date.now() / 1000);
  const sandboxPolicy = JSON.stringify({ type: 'workspace-write', network_access: false });

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(BOOTSTRAP_THREADS);
    // INSERT OR IGNORE: preserve any existing row (e.g. a Codex-created thread on
    // a machine that already has the session). Only adds a row when absent, so a
    // same-agent codex restore never overwrites Codex's own metadata.
    db.prepare(UPSERT_SQL).run(
      sessionId, rolloutPath, sec, sec,
      args.modelProvider || 'openai',
      cwd || '',
      title,
      sandboxPolicy,
      args.cliVersion || '',
      (args.title || '').slice(0, 200), // first_user_message
      preview,
    );
  } finally {
    db.close();
  }
  return { registered: true, dbPath };
}
