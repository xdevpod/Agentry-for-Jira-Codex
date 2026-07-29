/**
 * push.mjs — Shared client push module (full + incremental delta).
 *
 * Used by BOTH manual push (`jira_push_session` / `/jira-push-session`) and the
 * auto-push hook. This module resolves the session, constructs the append
 * payload, and dispatches it through an injected `send` function — it does NOT
 * decide throttle/gate (that is the caller's job, e.g. auto-push-logic).
 *
 * Protocol (matches server `POST /api/sessions/append`, S4):
 *   - full (`fromByte: 0`): read the entire session file as `tail`, send
 *     `{fromByte:0, tail:<full>}`. Returns the file's BYTE length so a caller
 *     can seed an offset if it wants (manual push ignores it; auto-push uses it
 *     to bootstrap `lastPushedByte`).
 *   - delta (`fromByte: <offset>`): read bytes [offset, fileSize) as `tail`,
 *     send `{fromByte:offset, tail}`. On success returns
 *     `{ pushedBytes, newOffset: fileSize }` (newOffset === fileSize) so the
 *     caller persists the offset. If the server returns 409 GAP (resync — its
 *     stored replay is shorter than our offset), surfaces `{ resync: true,
 *     storedReplayLen, fromByte }` so the caller can fall back to a full push.
 *
 * Byte-offset consistency: offsets are tracked in BYTES. Slicing the tail uses
 * Buffer.subarray(offset) on the UTF-8 bytes (never a char slice), and the
 * server appends those exact bytes — so alignment holds as long as the offset
 * the caller passes is always a previously-recorded byte length (never a
 * char-based or mid-codepoint value from a different basis). The session JSONL
 * is append-only (verified, incl. after compaction), so byte offsets are
 * monotonic.
 *
 * Dependency injection: `deps.send(payload)` performs the HTTP call (typically
 * `forgeClient.appendSession`). Tests inject a stub so no network is touched.
 */
import { readFileSync } from 'node:fs';

/**
 * Thrown by appendSession when the server returns 409 { resync: true } (the
 * client's fromByte is ahead of the server's stored replay length — a gap that
 * the tail cannot fill). The push module's delta path catches this and surfaces
 * `{ resync: true }` to the caller instead of treating it as a hard failure.
 */
export class ResyncError extends Error {
  constructor({ storedReplayLen, fromByte, message } = {}) {
    super(message || `Resync required: client fromByte ${fromByte} > server storedReplayLen ${storedReplayLen}`);
    this.name = 'ResyncError';
    this.code = 'RESYNC';
    this.storedReplayLen = storedReplayLen;
    this.fromByte = fromByte;
  }
}

/**
 * UTF-8 BYTE length of a string. Consistent basis for all offsets in this module.
 * @param {string} s
 * @returns {number}
 */
export function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Per-request byte budget for the JSON request body sent to the web trigger.
 *
 * The Forge web trigger / Atlassian gateway rejects oversized request bodies
 * with HTTP 413 BEFORE the body reaches our handler — so the server-side KVS
 * sharding (≤200 KB) cannot save a single huge POST. A ~4.7 MB transcript
 * JSON-escapes to ~7–9 MB (newlines + quotes double) and trips this limit on a
 * one-shot full push. This budget bounds each request so a large full push is
 * split into several bounded appends instead. 1 MiB is comfortably under any
 * plausible gateway limit while keeping the chunk count small (a 5 MB session
 * → ~5–10 requests). Tunable per-call via `pushSession({ maxBytesPerPush })`.
 */
export const MAX_PUSH_BYTES = 1024 * 1024; // 1 MiB total request-body budget

/**
 * Byte budget reserved for the request envelope (everything except `tail`):
 * op, accessToken, sessionId, projectName, fromByte, and the JSON keys/braces.
 * The chunker sizes each chunk's `tail` to fit within `MAX_PUSH_BYTES -
 * ENVELOPE_BUDGET`. 8 KiB is generous (tokens/sessionIds are a few hundred bytes).
 */
export const ENVELOPE_BUDGET = 8 * 1024;

/**
 * Split a UTF-8 JSONL buffer into complete-line chunks whose JSON-escaped
 * request body fits `maxBytes`. Returns `[{ fromByte, tail }]`.
 *
 * Why newline-aligned only:
 *   - The server's delta parser splits `tail` on '\n' and `JSON.parse`s each
 *     line, SILENTLY skipping any line that fails to parse. A mid-line cut would
 *     therefore drop that line from the parsed stream (only the safety-net
 *     full-reparse from replay would recover it). Cutting on '\n' keeps every
 *     chunk a complete set of lines → every line parses on the first pass.
 *   - '\n' is a single ASCII byte, so it is always a UTF-8 codepoint boundary.
 *     Cutting there guarantees no codepoint is split across the
 *     bytes→string→bytes round-trip through the JSON body — critical for
 *     multi-byte content (Chinese/emoji), which would otherwise corrupt.
 *
 * `fromByte` of each chunk is its absolute byte offset into `buf`; because the
 * server advances its storedBytes by the BYTE length of each accepted tail,
 * chunk[k]'s fromByte equals the server's storedBytes after chunk[k-1] →
 * `overlap === 0` on every delta → no 409 resync.
 *
 * A single line larger than the budget is emitted as its own (oversized) chunk —
 * best-effort; such lines are rare (huge single tool results) and the replay is
 * still byte-correct, so the safety-net reparse heals the parsed stream.
 *
 * @param {Buffer} buf       Raw UTF-8 bytes of the full session JSONL.
 * @param {number} maxBytes  Total request-body budget (tail + envelope).
 * @returns {Array<{fromByte: number, tail: string}>}
 */
export function chunkJsonlByLines(buf, maxBytes = MAX_PUSH_BYTES) {
  const tailBudget = Math.max(64, maxBytes - ENVELOPE_BUDGET);
  const NL = 0x0a;
  const n = buf.length;
  if (n === 0) return [{ fromByte: 0, tail: '' }];

  // Collect complete-line byte ranges [start, end); `end` includes the trailing
  // newline. The final line may have no trailing newline (still complete).
  const lines = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === NL) {
      lines.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < n) lines.push([start, n]);

  // Escaped BYTE length of JSON.stringify(buf[b..e]) — what the gateway sees.
  const escapedByteLen = (b, e) =>
    Buffer.byteLength(JSON.stringify(buf.subarray(b, e).toString('utf8')), 'utf8');

  // Greedily pack lines. JSON.stringify(A+B) is additive up to the 2 quote chars
  // shared between adjacent strings, so we track the running escaped length
  // incrementally (each line stringified once → O(n), not O(n²)).
  const chunks = [];
  let curStart = lines[0][0];
  let curEnd = lines[0][1];
  let curEscaped = escapedByteLen(curStart, curEnd);

  for (let k = 1; k < lines.length; k++) {
    const [ls, le] = lines[k];
    const lineEscaped = escapedByteLen(ls, le);
    const merged = curEscaped + lineEscaped - 2; // lose the 2 shared quote chars
    if (merged <= tailBudget) {
      curEnd = le;
      curEscaped = merged;
    } else {
      // Flush the current chunk (it fits); start a new one with this line.
      chunks.push({ fromByte: curStart, tail: buf.subarray(curStart, curEnd).toString('utf8') });
      curStart = ls;
      curEnd = le;
      curEscaped = lineEscaped; // a single oversize line stays one chunk
    }
  }
  chunks.push({ fromByte: curStart, tail: buf.subarray(curStart, curEnd).toString('utf8') });
  return chunks;
}

/**
 * Read the file (UTF-8) and slice bytes [offset, end). Returns a STRING decoded
 * from those exact bytes. Used for delta tail construction so byte alignment
 * with the server is preserved even across multi-byte codepoints.
 *
 * @param {string} filePath
 * @param {number} offset  Byte offset to start at (>= 0).
 * @returns {{ content: string, fullBytes: number }}  content = bytes[offset..],
 *   fullBytes = total byte length of the file.
 */
function readTailBytes(filePath, offset) {
  const buf = readFileSync(filePath); // raw bytes, no decode
  const fullBytes = buf.length;
  const start = Math.max(0, Math.min(offset, fullBytes));
  return { content: buf.subarray(start).toString('utf8'), fullBytes };
}

/**
 * Resolve + push a session. See module docstring for the full/delta contract.
 *
 * @param {object} args
 * @param {'full'|'delta'} args.mode  full = fromByte:0 (whole file);
 *   delta = fromByte:<offset> (bytes [offset,fileSize)).
 * @param {number} [args.fromByte]  Required for delta; ignored for full.
 * @param {(input:object)=>Promise<{content:string,filePath:string,sessionId:string,projectName:string}|null>} args.resolveSession
 *   Session resolver (typically `getRawJsonlContent({filePath}|{sessionId}|{})`).
 *   Receives an empty object by default (caller may pass a richer shape via
 *   `resolveInput`).
 * @param {object} [args.resolveInput]  Passed to resolveSession (e.g.
 *   `{filePath}` or `{sessionId}`).
 * @param {object} args.deps
 * @param {(payload:object)=>Promise<object>} args.deps.send  HTTP send seam
 *   (typically `(p) => forgeClient.appendSession(p)`). Throws ResyncError on
 *   409 GAP; other throws propagate.
 * @param {string} [args.projectPath]  Real cwd at push time.
 * @param {boolean} [args.isSessionEnd]  True on the final SessionEnd flush.
 * @returns {Promise<object>}
 *   full → { mode:'full', byteLength:<fileBytes> }
 *   delta success → { mode:'delta', pushedBytes, newOffset:<fileBytes> }
 *   delta resync → { mode:'delta', resync:true, storedReplayLen, fromByte }
 */
export async function pushSession({
  mode,
  fromByte,
  resolveSession,
  resolveInput = {},
  deps,
  projectPath,
  isSessionEnd,
  agent = 'claude',
  maxBytesPerPush = MAX_PUSH_BYTES,
}) {
  if (!deps || typeof deps.send !== 'function') {
    throw new Error('pushSession: deps.send (async) is required');
  }
  if (mode !== 'full' && mode !== 'delta') {
    throw new Error(`pushSession: unknown mode "${mode}" (expected 'full' or 'delta')`);
  }
  if (mode === 'delta' && (typeof fromByte !== 'number' || !Number.isFinite(fromByte) || fromByte < 0)) {
    throw new Error(`pushSession: delta mode requires a finite non-negative fromByte (got ${fromByte})`);
  }

  const raw = await resolveSession(resolveInput);
  if (!raw) throw new Error('pushSession: no session resolved');

  // Common payload fields (mirror pushSession's shape + the S4 append contract).
  const basePayload = {
    sessionId: raw.sessionId,
    projectName: raw.projectName,
    agent,
  };
  if (projectPath) basePayload.projectPath = projectPath;
  if (isSessionEnd) basePayload.isSessionEnd = isSessionEnd;

  if (mode === 'full') {
    // Whole-file push. Small files go in one request (fromByte 0 = init). Large
    // files — whose single-shot POST would exceed the web-trigger body limit and
    // 413 — are split on newline boundaries into bounded sequential appends: the
    // first chunk is the init (fromByte 0), the rest are delta appends whose
    // fromByte equals the server's storedBytes after the preceding chunk (so
    // overlap === 0, no resync). The server already supports this — init seeds
    // storedBytes to the accepted tail's byte length, and deltas append.
    const buf = Buffer.from(raw.content, 'utf8');
    const fullBytes = buf.length;
    const chunks = chunkJsonlByLines(buf, maxBytesPerPush);
    if (chunks.length <= 1) {
      // Fits one request → unchanged single-shot init.
      await deps.send({ ...basePayload, fromByte: 0, tail: raw.content });
      return { mode: 'full', byteLength: fullBytes };
    }
    for (const c of chunks) {
      await deps.send({ ...basePayload, fromByte: c.fromByte, tail: c.tail });
    }
    return { mode: 'full', byteLength: fullBytes, chunked: true, chunks: chunks.length };
  }

  // --- delta ---
  // Byte offsets must be integers — a fractional offset has no meaning at the
  // byte level and would silently misalign the trim. Reject it loudly rather
  // than truncating (a truncated fractional offset could double-count or drop
  // bytes across a codepoint boundary).
  if (!Number.isInteger(fromByte)) {
    throw new Error(
      `pushSession: delta mode requires an integer fromByte (got ${fromByte}); ` +
      'fractional byte offsets are not valid — reseed from a recorded byte length.'
    );
  }
  const offset = fromByte;
  const { content: tail, fullBytes } = readTailBytes(raw.filePath, offset);

  try {
    await deps.send({ ...basePayload, fromByte: offset, tail });
  } catch (e) {
    if (e instanceof ResyncError || e?.code === 'RESYNC') {
      // Surface resync so the caller can fall back to a full push. Do NOT
      // advance newOffset — the offset is invalid against the server's state.
      return {
        mode: 'delta',
        resync: true,
        storedReplayLen: e.storedReplayLen,
        fromByte: offset,
      };
    }
    throw e; // propagate other errors (network, 500, etc.)
  }

  const pushedBytes = byteLength(tail);
  return {
    mode: 'delta',
    pushedBytes,
    newOffset: fullBytes, // offset + pushedBytes === fullBytes (tail = bytes[offset..])
  };
}
