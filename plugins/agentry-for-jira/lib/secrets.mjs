/**
 * secrets.mjs — NON-SECRET plugin config file (~/.agentry-for-jira/config.json,
 * chmod 0600).
 *
 * Holds the NON-SECRET values written by /jira-setup: JIRA_WEBTRIGGER_URL (and
 * JIRA_ACCESS_EXP). The OAuth access/refresh token PAIR is a secret — it lives
 * in the OS keychain (lib/keychain.mjs), NEVER here. config.mjs overlays this
 * file on top of process.env (file wins), so /jira-setup is authoritative while
 * settings.json `env` users keep working.
 *
 * No Jira API token anywhere. The file path is injectable so tests use tmp dirs
 * instead of the real home directory.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_FILE } from './paths.mjs';

/** Default on-disk path (~/.agentry-for-jira/config.json). */
export function defaultConfigPath() {
  return CONFIG_FILE;
}

/**
 * Load and parse the config file. Returns {} for missing / invalid JSON /
 * non-object values (never throws — callers fall back to env).
 * @param {string} [filePath]
 * @returns {Record<string, string>}
 */
export function loadConfigFile(filePath = CONFIG_FILE) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Write the config object, creating parent dirs and chmod-ing to 0600 so the
 * file is owner-read/write only (the API token lives here).
 * @param {object} obj
 * @param {string} [filePath]
 * @returns {string} The path written.
 */
export function saveConfigFile(obj, filePath = CONFIG_FILE) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on non-posix filesystems */
  }
  return filePath;
}
