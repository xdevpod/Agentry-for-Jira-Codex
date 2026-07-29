#!/usr/bin/env node
/**
 * check-config-hook.mjs — SessionStart hook.
 *
 * On every session start, checks whether the session-sync prereqs are set
 * (via the layered config: ~/.agentry-for-jira/config.json over process.env).
 * If anything is missing, emits a one-line `additionalContext` nudging the user
 * to run /jira-setup. When fully configured it is SILENT (prints nothing).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkForgeConfig } from './config.mjs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * @param {object} [env]  Injected env (tests); defaults to the layered config.
 * @returns {string|null}  One-line nudge naming missing vars, or null when configured.
 */
export function buildNudge(env) {
  const cfg = checkForgeConfig(env);
  if (cfg.ok) return null;
  return `⚠️ Jira session-sync not configured — run /jira-setup (missing: ${cfg.missing.join(', ')}).`;
}

function main() {
  readStdin(); // consume the hook payload (not needed here)
  const msg = buildNudge(); // reads the layered env (config.json + process.env)
  if (msg) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: msg,
        },
      })
    );
  }
  process.exit(0);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
