#!/usr/bin/env node
/**
 * codex-check-config-hook.mjs — Codex `SessionStart` hook.
 *
 * Mirrors lib/check-config-hook.mjs (the Claude Code SessionStart entry), but
 * localizes the nudge to Codex's `$jira-setup` skill syntax instead of
 * Claude's `/jira-setup` slash command. Same prereq check (checkForgeConfig),
 * same silent-when-configured behavior.
 *
 * Codex `SessionStart` stdout contract (per developers.openai.com/codex/hooks):
 * plain text OR `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 * are both accepted and injected as extra developer context — identical
 * envelope shape to Claude Code's SessionStart hook, so this only differs from
 * check-config-hook.mjs in the setup-command wording, not the output protocol.
 * When fully configured, this hook is SILENT (prints nothing).
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
  return `⚠️ Jira session-sync not configured — run $jira-setup (missing: ${cfg.missing.join(', ')}).`;
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
