import { mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 250;

export function lockFilePath(sessionId, baseDir) {
  return join(baseDir, 'jira-sync-locks', `${sessionId}.lock`);
}

function writeLockMetadata(filePath) {
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  writeFileSync(filePath, payload, 'utf8');
}

function removeLock(filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

function isStale(filePath, staleMs) {
  try {
    const st = statSync(filePath);
    return (Date.now() - st.mtimeMs) > staleMs;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireSessionLock(sessionId, baseDir, opts = {}) {
  const {
    wait = false,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
  } = opts;
  const filePath = lockFilePath(sessionId, baseDir);
  mkdirSync(dirname(filePath), { recursive: true });

  for (;;) {
    try {
      const fd = openSync(filePath, 'wx');
      try {
        writeLockMetadata(filePath);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        filePath,
        release() {
          if (released) return;
          released = true;
          removeLock(filePath);
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (isStale(filePath, staleMs)) {
        removeLock(filePath);
        continue;
      }
      if (!wait) return null;
      await sleep(pollMs);
    }
  }
}

export function readLockMetadata(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
