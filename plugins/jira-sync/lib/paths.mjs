/** paths.mjs — central jira-sync filesystem locations. */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Agent-neutral root for all jira-sync-owned files (~/.jira-sync). */
export const JIRA_SYNC_DIR = join(homedir(), '.jira-sync');

/** Non-secret config: webtrigger URL, site URL, auto-push flag, cached clientIds. */
export const CONFIG_FILE = join(JIRA_SYNC_DIR, 'config.json');

/** OAuth token fallback file (primary store is the OS keychain, path-independent). */
export const TOKENS_FILE = join(JIRA_SYNC_DIR, 'tokens.json');

/** Stable machine fingerprint fallback (write-once; only its hash is ever sent). */
export const MACHINE_ID_FILE = join(JIRA_SYNC_DIR, 'machine-id');

/**
 * Root for per-session auto-push state. Throttle/link state land in
 * ~/.jira-sync/jira-sync-throttle(-link)/ via auto-push-logic.mjs's path helpers
 * (which append those subdir names to this base).
 */
export const STATE_BASE_DIR = JIRA_SYNC_DIR;
