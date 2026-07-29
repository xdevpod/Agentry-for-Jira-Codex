/** paths.mjs — central Agentry for Jira filesystem locations. */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Agent-neutral root for all Agentry-for-Jira-owned files (~/.agentry-for-jira). */
export const AGENTRY_DIR = join(homedir(), '.agentry-for-jira');

/** Non-secret config: webtrigger URL, site URL, auto-push flag, cached clientIds. */
export const CONFIG_FILE = join(AGENTRY_DIR, 'config.json');

/** OAuth token fallback file (primary store is the OS keychain, path-independent). */
export const TOKENS_FILE = join(AGENTRY_DIR, 'tokens.json');

/** Stable machine fingerprint fallback (write-once; only its hash is ever sent). */
export const MACHINE_ID_FILE = join(AGENTRY_DIR, 'machine-id');

/**
 * Root for per-session auto-push state. Throttle/link state land in
 * ~/.agentry-for-jira/throttle(-link)/ via auto-push-logic.mjs's path helpers
 * (which append those subdir names to this base).
 */
export const STATE_BASE_DIR = AGENTRY_DIR;
