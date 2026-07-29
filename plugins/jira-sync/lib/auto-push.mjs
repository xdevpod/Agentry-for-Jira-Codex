#!/usr/bin/env node
/**
 * auto-push.mjs — Auto-push the current session to the Forge Session Tracker.
 *
 * Fired by BOTH the Stop hook (throttled) and the SessionEnd hook (final flush).
 * The two events are distinguished from stdin `hook_event_name`. See
 * lib/auto-push-logic.mjs for the decision rules (runHook).
 *
 * Gate:   JIRA_AUTO_PUSH === 'true'
 * Prereqs: JIRA_WEBTRIGGER_URL (env/config) + an OAuth token pair in the OS
 *          keychain (lib/keychain.mjs). The ForgeClient loads/rotates the token
 *          pair lazily — no Jira API token, no /myself.
 *
 * Silent + non-blocking: prints nothing to stdout, always exits 0. Never emits a
 * `decision:block` JSON (that would loop the Stop hook).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ForgeClient } from './forge-client.mjs';
import { getRawJsonlContent, parseSession } from './transcript-parser.mjs';
import { readEnv } from './config.mjs';
import { runHook } from './auto-push-logic.mjs';
import { pushSession as sharedPush } from './push.mjs';
import { STATE_BASE_DIR } from './paths.mjs';

/** Read all of stdin (fd 0) as UTF-8; '' if unavailable. */
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

async function main() {
  const env = readEnv(); // merges ~/.jira-sync/config.json over process.env
  const stdinText = readStdin();

  // Prefer the hook's transcript_path (exact), then session_id, then the finders.
  const resolveSession = (input) => {
    const opts = input.transcriptPath
      ? { filePath: input.transcriptPath }
      : input.sessionId
        ? { sessionId: input.sessionId }
        : {};
    return getRawJsonlContent(opts);
  };

  // Lazy forge client — only constructed when we actually push (after the prereq
  // gate inside runHook), so a missing OAuth env won't throw at startup.
  let forge = null;
  const getForge = () => {
    if (!forge) {
      forge = new ForgeClient({
        webtriggerUrl: env.JIRA_WEBTRIGGER_URL,
      });
    }
    return forge;
  };
  // `deps.push` is a closure over the SHARED push module (lib/push.mjs). It
  // carries `resolveSession` + the HTTP `send` fn so runHook only needs to pass
  // the orchestration args {mode, fromByte, projectPath, isSessionEnd}. This is
  // the single push path for both Stop (throttled full/delta) and SessionEnd
  // (flush); the module constructs the append payload and dispatches it.
  const push = (args) => sharedPush({
    ...args,
    resolveSession,
    deps: { send: (p) => getForge().appendSession(p) },
  });
  const linkSession = async (sessionId, issueKey) => {
    return getForge().linkSession(sessionId, issueKey, { context: 'auto' });
  };

  await runHook({
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
}

// runHook never throws on its own, but ForgeClient construction / network can;
// either way, never block Claude Code — always exit 0.
main().then(() => process.exit(0)).catch(() => process.exit(0));
