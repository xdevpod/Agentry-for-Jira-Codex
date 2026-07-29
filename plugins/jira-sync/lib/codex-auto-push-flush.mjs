#!/usr/bin/env node
/**
 * codex-auto-push-flush.mjs — best-effort delayed flush for Codex auto-push.
 *
 * Codex only exposes Stop hooks, so a throttled final turn can otherwise leave
 * an unpushed tail forever if the user goes idle. The Stop hook schedules this
 * detached helper to wake up at the throttle boundary and perform one synthetic
 * "idle flush" if no newer push has superseded it.
 */
import { ForgeClient } from './forge-client.mjs';
import { getAdapter } from './agents/index.mjs';
import { readEnv } from './config.mjs';
import {
  runHook,
  throttleFilePath,
  readPendingFlushAt,
  readThrottle,
} from './auto-push-logic.mjs';
import { pushSession as sharedPush } from './push.mjs';
import { STATE_BASE_DIR } from './paths.mjs';

const adapter = getAdapter('codex');
const { getRawJsonlContent, parseSession } = adapter;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function main() {
  const sessionId = process.argv[2];
  const targetMs = Number(process.argv[3]);
  if (!sessionId || !Number.isFinite(targetMs)) return;

  await sleep(targetMs - Date.now());

  const tpath = throttleFilePath(sessionId, STATE_BASE_DIR);
  if (readPendingFlushAt(tpath) !== targetMs) return;

  const lastPushMs = readThrottle(tpath);
  if (typeof lastPushMs === 'number' && lastPushMs >= targetMs) return;

  const env = readEnv();
  const resolveSession = (input) => {
    const opts = input.sessionId
      ? { sessionId: input.sessionId }
      : input.transcriptPath
        ? { filePath: input.transcriptPath }
        : {};
    return getRawJsonlContent(opts);
  };

  let forge = null;
  const getForge = () => {
    if (!forge) {
      forge = new ForgeClient({ webtriggerUrl: env.JIRA_WEBTRIGGER_URL });
    }
    return forge;
  };
  const push = (args) => sharedPush({
    ...args,
    resolveSession,
    agent: 'codex',
    deps: { send: (p) => getForge().appendSession(p) },
  });
  const linkSession = async (id, issueKey) => {
    return getForge().linkSession(id, issueKey, { context: 'auto' });
  };

  await runHook({
    stdinText: JSON.stringify({
      hook_event_name: 'SessionIdleFlush',
      session_id: sessionId,
    }),
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
}

main().catch(() => {});
