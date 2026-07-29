/**
 * config.mjs — NON-SECRET configuration for the Jira session-sync plugin.
 *
 * Only non-secret values live in process.env / ~/.jira-sync/config.json:
 *   JIRA_WEBTRIGGER_URL    (required) session-sync web trigger URL
 *   JIRA_SITE_URL          (optional) Jira site origin, powers /browse/ links
 *   JIRA_AUTO_PUSH         (optional) enable auto-sync, default false
 *   JIRA_AUTO_PUSH_INTERVAL (optional) throttle seconds, default 120
 *
 * The OAuth access/refresh TOKEN PAIR is a SECRET — it lives in the OS keychain
 * (lib/keychain.mjs), never in config.json or env. loadConfig() does NOT load
 * tokens; the ForgeClient loads/persists them lazily and rotates on demand.
 *
 * Config source is layered: process.env overlaid with the 0600 config file
 * (file wins), so /jira-setup is authoritative while settings.json `env` users
 * keep working. This module stayed sync on purpose — token loading (async,
 * keychain) is the ForgeClient's job, not the gate's.
 */
import { loadConfigFile } from './secrets.mjs';

const REQUIRED_VARS = ['JIRA_WEBTRIGGER_URL'];

export function readEnv() {
  return { ...process.env, ...loadConfigFile() };
}

/** Prerequisites for the Forge Session Tracker path that live in env/config. */
export const FORGE_PREREQ_VARS = ['JIRA_WEBTRIGGER_URL'];

/**
 * Load and validate non-secret config. Throws ConfigError if the web trigger URL
 * is missing.
 * @param {object} [options]
 * @param {object} [options.env] - Injected env (tests); defaults to readEnv().
 * @returns {{ webtriggerUrl, siteUrl, autoPush }}
 */
export function loadConfig(options = {}) {
  const env = options.env || readEnv();
  const missing = REQUIRED_VARS.filter((v) => !env[v]);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing: ${missing.join(', ')}. Set JIRA_WEBTRIGGER_URL via /jira-setup ` +
      '(writes ~/.jira-sync/config.json) or in settings.json env.'
    );
  }
  return {
    webtriggerUrl: env.JIRA_WEBTRIGGER_URL || null,
    siteUrl: env.JIRA_SITE_URL || null,
    autoPush: env.JIRA_AUTO_PUSH === 'true',
    // Cached deterministic terminal id (non-secret, recomputable). Absent until
    // the first registration computes + caches it via client-identity.mjs.
    clientId: env.JIRA_CLIENT_ID || null,
    // LAN IPv4 collection for terminal metadata; opt out with JIRA_COLLECT_IP=false.
    collectIp: env.JIRA_COLLECT_IP !== 'false',
  };
}

/** Non-throwing prereq check (web trigger URL present). */
export function checkConfig() {
  const env = readEnv();
  const missing = REQUIRED_VARS.filter((v) => !env[v]);
  return { ok: missing.length === 0, missing };
}

/** Config summary with no secrets (none live here anymore). */
export function configSummary(config) {
  return {
    webtriggerUrl: config.webtriggerUrl,
    siteUrl: config.siteUrl || '(not set)',
    autoPush: config.autoPush,
    clientId: config.clientId || '(not yet registered)',
    collectIp: config.collectIp,
  };
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Forge Session Tracker auto-push helpers
// ---------------------------------------------------------------------------

/**
 * Non-throwing check of the env/config prereqs (web trigger URL). Token presence
 * is NOT checked here — tokens live in the keychain and are verified at push time
 * (and by /jira-setup's whoami). Used by the auto-push gate + SessionStart nudge.
 * @param {object} [env] - Injected env (tests); defaults to readEnv().
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkForgeConfig(env = readEnv()) {
  const missing = FORGE_PREREQ_VARS.filter((v) => !env[v]);
  return { ok: missing.length === 0, missing };
}

/** Auto-push throttle interval in seconds (default 120). */
export function getIntervalSeconds(env = process.env) {
  const raw = parseInt(env.JIRA_AUTO_PUSH_INTERVAL, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}
