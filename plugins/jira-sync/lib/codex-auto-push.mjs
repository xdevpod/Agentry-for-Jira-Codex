#!/usr/bin/env node
/**
 * codex-auto-push.mjs — Codex `Stop` hook: auto-push the current Codex session
 * to the Forge Session Tracker.
 *
 * Mirrors lib/auto-push.mjs (the Claude Stop/SessionEnd entry), but forces the
 * Codex adapter (locates ~/.codex/sessions rollouts) and stamps agent='codex' on
 * every push. Codex has NO SessionEnd event — Stop is turn-scoped, so each turn
 * runs the throttled incremental push (full on first push, byte-delta after).
 *
 * Gate:   JIRA_AUTO_PUSH === 'true' (read via readEnv → ~/.jira-sync/config.json)
 * Prereqs: JIRA_WEBTRIGGER_URL + an OAuth token pair in the OS keychain.
 *
 * Codex `Stop` stdout contract (per developers.openai.com/codex/hooks): "Stop
 * expects JSON on stdout when it exits 0. Plain text is invalid." We emit `{}`
 * (empty JSON) — satisfies the JSON contract, has no `decision`, so Codex
 * continues normally without triggering a continuation turn. NEVER emit
 * decision:"block" (for Stop that means "continue" = run a new turn = loop).
 * Diagnostics go to stderr (Codex surfaces them as warnings but keeps going).
 * Always exit 0.
 *
 * Trust gate: Codex skips non-managed hooks until you review+trust them via
 * `/hooks`. A newly-added Stop hook will NOT run until trusted.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForgeClient } from './forge-client.mjs';
import { getAdapter } from './agents/index.mjs';
import { readEnv, getIntervalSeconds } from './config.mjs';
import {
  runHook,
  throttleFilePath,
  readThrottle,
  readPendingFlushAt,
  writePendingFlushAt,
} from './auto-push-logic.mjs';
import { pushSession as sharedPush } from './push.mjs';
import { STATE_BASE_DIR } from './paths.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);

/** Codex-only entry — always resolves sessions via the Codex adapter. */
const adapter = getAdapter('codex');
const { getRawJsonlContent, parseSession } = adapter;

/** Read all of stdin (fd 0) as UTF-8; '' if unavailable. */
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Emit the Codex Stop contract output (empty JSON) and exit 0 — always. */
function finish() {
  try { process.stdout.write('{}'); } catch { /* ignore */ }
  process.exit(0);
}

function parseStdinJson(stdinText) {
  try {
    const json = JSON.parse(stdinText || '{}');
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

function scheduleIdleFlush(sessionId, env) {
  if (!sessionId) return;
  const tpath = throttleFilePath(sessionId, STATE_BASE_DIR);
  const lastPushMs = readThrottle(tpath);
  if (lastPushMs == null) return;

  const targetMs = lastPushMs + (getIntervalSeconds(env) * 1000);
  const existing = readPendingFlushAt(tpath);
  if (existing != null && existing >= targetMs) return;

  writePendingFlushAt(tpath, targetMs);
  const child = spawn(
    process.execPath,
    [join(dirname(THIS_FILE), 'codex-auto-push-flush.mjs'), sessionId, String(targetMs)],
    {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    },
  );
  child.unref();
}

async function main() {
  const env = readEnv(); // merges ~/.jira-sync/config.json over process.env
  const stdinText = readStdin();
  const input = parseStdinJson(stdinText);

  // Codex's `transcript_path` format is not stable (per the hooks spec), so
  // prefer `session_id` (the rollout filename ends with it → findSessionFile is
  // reliable), then transcript_path, then the cwd/finders fallback.
  const resolveSession = (input) => {
    const opts = input.sessionId
      ? { sessionId: input.sessionId }
      : input.transcriptPath
        ? { filePath: input.transcriptPath }
        : {};
    return getRawJsonlContent(opts);
  };

  // Lazy forge client — only constructed when we actually push (after the prereq
  // gate inside runHook), so a missing OAuth env won't throw at startup.
  let forge = null;
  const getForge = () => {
    if (!forge) {
      forge = new ForgeClient({ webtriggerUrl: env.JIRA_WEBTRIGGER_URL });
    }
    return forge;
  };
  // `deps.push` closes over the SHARED push module (lib/push.mjs), carrying
  // `resolveSession` + the HTTP `send` fn + the codex agent stamp, so runHook
  // only passes orchestration args {mode, fromByte, projectPath, isSessionEnd}.
  const push = (args) => sharedPush({
    ...args,
    resolveSession,
    agent: 'codex',
    deps: { send: (p) => getForge().appendSession(p) },
  });
  const linkSession = async (sessionId, issueKey) => {
    return getForge().linkSession(sessionId, issueKey, { context: 'auto' });
  };

  const result = await runHook({
    stdinText,
    env,
    deps: {
      resolveSession,
      parseSession,
      push,
      linkSession,
      now: () => Date.now(),
      projectPath: process.cwd(),
      stateBaseDir: STATE_BASE_DIR,
    },
  });

  if (result?.action === 'skip' && result.reason === 'throttled') {
    scheduleIdleFlush(input.session_id ?? null, env);
  }
}

// runHook never throws on its own, but ForgeClient construction / network can;
// either way, never block Codex — always emit `{}` (Stop JSON contract) + exit 0.
main().then(finish).catch(finish);
