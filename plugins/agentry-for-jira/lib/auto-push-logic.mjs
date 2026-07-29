/**
 * auto-push-logic.mjs — Pure decision logic for the Stop/SessionEnd auto-push hook.
 *
 * Side-effecting I/O is kept minimal and goes through the throttle-state file fns
 * (testable with tmp dirs) or, in runHook (Task 4), through injected deps so the
 * orchestration is unit-testable without a network or a real session.
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkForgeConfig, getIntervalSeconds } from './config.mjs';
import { acquireSessionLock } from './session-lock.mjs';

/**
 * Parse the hook's stdin JSON into a normalized shape. Safe on bad/empty input.
 * @param {string} stdinText
 * @returns {{ hookEventName: string|null, sessionId: string|null, transcriptPath: string|null }}
 */
export function parseHookInput(stdinText) {
  const fallback = { hookEventName: null, sessionId: null, transcriptPath: null };
  let json;
  try { json = JSON.parse(stdinText); } catch { return fallback; }
  if (!json || typeof json !== 'object') return fallback;
  return {
    hookEventName: json.hook_event_name ?? null,
    sessionId: json.session_id ?? null,
    transcriptPath: json.transcript_path ?? null,
  };
}

/**
 * Decide whether to push this event, and whether it is the final (SessionEnd) flush.
 * The content gate (humanMessageCount < minMessages) always wins.
 * SessionEnd ignores the throttle; Stop respects it.
 *
 * @returns {{ push: boolean, reason: string, isFinal: boolean }}
 */
export function decidePush({ hookEventName, lastPushMs, now, intervalMs, humanMessageCount, minMessages = 2 }) {
  if (!humanMessageCount || humanMessageCount < minMessages) {
    return { push: false, reason: 'too-few-messages', isFinal: false };
  }
  if (hookEventName === 'SessionEnd') {
    return { push: true, reason: 'session-end-flush', isFinal: true };
  }
  if (hookEventName === 'SessionIdleFlush') {
    return { push: true, reason: 'idle-flush', isFinal: false };
  }
  if (hookEventName === 'Stop') {
    if (lastPushMs == null) return { push: true, reason: 'first-push', isFinal: false };
    if (now - lastPushMs >= intervalMs) return { push: true, reason: 'throttle-elapsed', isFinal: false };
    return { push: false, reason: 'throttled', isFinal: false };
  }
  return { push: false, reason: 'unknown-event', isFinal: false };
}

/** Path to a session's throttle-state file under baseDir. */
export function throttleFilePath(sessionId, baseDir) {
  return join(baseDir, 'jira-sync-throttle', `${sessionId}.json`);
}

/** Read the whole throttle-state object, or {} if missing/invalid JSON. */
function readThrottleObject(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

/** Merge a partial patch into the throttle-state file (read-modify-write). */
function patchThrottle(filePath, patch) {
  mkdirSync(dirname(filePath), { recursive: true });
  const merged = { ...readThrottleObject(filePath), ...patch };
  writeFileSync(filePath, JSON.stringify(merged));
}

/** Read lastPushMs from a throttle file, or null if missing/invalid. */
export function readThrottle(filePath) {
  const ms = readThrottleObject(filePath).lastPushMs;
  return typeof ms === 'number' ? ms : null;
}

/** Write lastPushMs to a throttle file, preserving lastPushedByte. */
export function writeThrottle(filePath, ms) {
  patchThrottle(filePath, { lastPushMs: ms });
}

/** Read lastPushedByte from a throttle file, or null if missing/invalid. */
export function readOffset(filePath) {
  const off = readThrottleObject(filePath).lastPushedByte;
  return typeof off === 'number' ? off : null;
}

/** Write lastPushedByte to a throttle file, preserving lastPushMs. */
export function writeOffset(filePath, bytes) {
  patchThrottle(filePath, { lastPushedByte: bytes });
}

/** Read pendingFlushAt from a throttle file, or null if missing/invalid. */
export function readPendingFlushAt(filePath) {
  const ts = readThrottleObject(filePath).pendingFlushAt;
  return typeof ts === 'number' ? ts : null;
}

/** Write pendingFlushAt to a throttle file, preserving other state. */
export function writePendingFlushAt(filePath, ms) {
  patchThrottle(filePath, { pendingFlushAt: ms });
}

/** Clear pendingFlushAt from a throttle file, preserving other state. */
export function clearPendingFlushAt(filePath) {
  const current = readThrottleObject(filePath);
  if (!Object.prototype.hasOwnProperty.call(current, 'pendingFlushAt')) return;
  delete current.pendingFlushAt;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(current));
}

/** Delete a throttle file if it exists. Idempotent. */
export function deleteThrottle(filePath) {
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

/** Path to a session's link-state file under baseDir. */
export function linkFilePath(sessionId, baseDir) {
  return join(baseDir, 'jira-sync-link', `${sessionId}.json`);
}

/** Read the issue key this session should be linked to, or null if unset/invalid. */
export function readSessionLink(sessionId, baseDir) {
  try {
    const data = JSON.parse(readFileSync(linkFilePath(sessionId, baseDir), 'utf8'));
    return typeof data.issueKey === 'string' && data.issueKey ? data.issueKey : null;
  } catch { return null; }
}

/**
 * Orchestration seam for the auto-push hook. All side effects go through `deps`,
 * so this is unit-testable with mocks. May reject if an injected dep rejects
 * (e.g. pushSession network failure); the entry script (auto-push.mjs) wraps the
 * call in try/catch and exits 0 regardless.
 *
 * @param {object} args
 * @param {string} args.stdinText   Raw hook stdin (JSON).
 * @param {object} args.env         Resolved env (usually process.env).
 * @param {object} args.deps        Injectable side effects:
 *   - resolveSession(input): Promise<{filePath,sessionId,projectName,content}|null>
 *   - parseSession(filePath): Promise<{humanMessages: any[]}>
 *   - push(args): Promise<{mode:'full',byteLength} | {mode:'delta',pushedBytes,newOffset} | {mode:'delta',resync:true,...}>
 *       Shared push module seam (lib/push.mjs). Receives {mode, fromByte,
 *       projectPath, isSessionEnd} — the production closure (auto-push.mjs)
 *       already carries `resolveSession` + the HTTP `send` fn. On resync the
 *       caller (here) falls back to a full push.
 *   - linkSession(sessionId, issueKey): Promise<any>
 *   - now(): number
 *   - projectPath: string
 *   - stateBaseDir: string  (root under which jira-sync-throttle/ and jira-sync-link/ live)
 * @returns {Promise<{ action: 'push'|'skip', reason: string, isFinal?: boolean, missing?: string[] }>}
 */
export async function runHook({ stdinText, env, deps }) {
  const input = parseHookInput(stdinText);

  if (env.JIRA_AUTO_PUSH !== 'true') return { action: 'skip', reason: 'disabled' };

  const cfg = checkForgeConfig(env);
  if (!cfg.ok) return { action: 'skip', reason: 'missing-prereqs', missing: cfg.missing };

  const raw = await deps.resolveSession(input);
  if (!raw) return { action: 'skip', reason: 'no-session' };

  const lock = await acquireSessionLock(raw.sessionId, deps.stateBaseDir, { wait: false });
  if (!lock) return { action: 'skip', reason: 'locked' };

  try {
    const parsed = await deps.parseSession(raw.filePath);
    const tpath = throttleFilePath(raw.sessionId, deps.stateBaseDir);
    const last = readThrottle(tpath);
    const now = deps.now();
    const decision = decidePush({
      hookEventName: input.hookEventName,
      lastPushMs: last,
      now,
      intervalMs: getIntervalSeconds(env) * 1000,
      humanMessageCount: parsed.humanMessages.length,
    });
    if (!decision.push) return { action: 'skip', reason: decision.reason };

    // --- Incremental push via the shared module (lib/push.mjs) ---
    // Decide full vs delta from the persisted byte offset. fromByte 0 = full
    // (first push / no offset / manual reset); fromByte = offset = delta (tail).
    // `deps.push` is the shared push module seam: in production it's a closure
    // that already carries `resolveSession` + the HTTP `send` fn (wired in
    // auto-push.mjs), so runHook only passes the orchestration args
    // {mode, fromByte, projectPath, isSessionEnd}. Tests inject a stub.
    const isSessionEnd = decision.isFinal;
    const pushArgs = (mode, fromByte) => ({
      mode,
      fromByte,
      projectPath: deps.projectPath,
      isSessionEnd,
    });

    const offsetBefore = readOffset(tpath);
    let fromByte = offsetBefore || 0;
    let mode = fromByte === 0 ? 'full' : 'delta';

    let result = await deps.push(pushArgs(mode, fromByte));

    // Delta returned resync (client offset > server stored replay) -> fall back to
    // a full push (fromByte 0), then seed the offset from the full byteLength.
    if (mode === 'delta' && result && result.resync === true) {
      result = await deps.push(pushArgs('full', 0));
    }

    // Persist the new offset ONLY on a successful push (full or delta). A failed
    // push throws before reaching here, so the offset is unchanged and the next
    // attempt retries the same delta.
    if (result && result.mode === 'full' && typeof result.byteLength === 'number') {
      writeOffset(tpath, result.byteLength);
    } else if (result && result.mode === 'delta' && typeof result.newOffset === 'number') {
      writeOffset(tpath, result.newOffset);
    }

    if (isSessionEnd) {
      deleteThrottle(tpath);
    } else {
      writeThrottle(tpath, now);
      clearPendingFlushAt(tpath);
    }

    const linkKey = readSessionLink(raw.sessionId, deps.stateBaseDir);
    if (linkKey) {
      await deps.linkSession(raw.sessionId, linkKey);
    }
    return { action: 'push', reason: decision.reason, isFinal: decision.isFinal };
  } finally {
    lock.release();
  }
}
