/**
 * token-bundle.mjs — single-string packaging of the 5 setup values so the user
 * can move URL + access + refresh + expiry + site URL from the Jira UI to the
 * keychain in ONE clipboard copy (see the "Copy setup bundle" button on the
 * token card), never typing a token and never routing it through the Claude
 * transcript.
 *
 * Format:  `ai-co-work-jira-sync1.` + JSON {u,a,r,e}   (PLAINTEXT — not encoded)
 *
 * Plaintext on purpose: the access/refresh tokens are visible (`at_…` / `rt_…`)
 * so a glance makes obvious this is a credential. Opaque base64 looked "safe to
 * share" and users pasted it into chat — base64 is encoding, not encryption, so
 * that leaked the tokens. No encoding also means the frontend (JSON.stringify)
 * and node (JSON.parse) share one trivial format.
 *
 * `store-token.mjs --from-clipboard` consumes this; it never echoes the bundle,
 * so the token bytes stay out of any transcript that captures the command's
 * stdout.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const BUNDLE_PREFIX = 'ai-co-work-jira-sync1.';

/** Hard ceiling on any single clipboard CLI call so a misbehaving pbcopy/pbcopy
 *  in a sandboxed shell can't hang store-token (the scrub is best-effort). */
const CLIP_TIMEOUT_MS = 3000;

/**
 * Build a bundle string from the 5 setup values (node side; the frontend
 * replicates this with JSON.stringify — keep the two in sync). `s` (site URL)
 * is omitted from the JSON when unset, so callers that don't supply it produce
 * the legacy 4-field bundle.
 * @param {{webtriggerUrl:string, accessToken:string, refreshToken:string, accessExp:number, siteUrl?:string}} v
 * @returns {string}
 */
export function buildBundle({ webtriggerUrl, accessToken, refreshToken, accessExp, siteUrl }) {
  return BUNDLE_PREFIX + JSON.stringify({
    u: webtriggerUrl,
    a: accessToken,
    r: refreshToken,
    e: accessExp,
    s: siteUrl,
  });
}

/**
 * Parse a bundle string. Returns null for anything that isn't a well-formed
 * bundle carrying all 4 values (never throws — callers fall back to interactive
 * input). Tolerates a trailing newline (clipboard managers often add one).
 * @param {string} raw
 * @returns {{webtriggerUrl:string, accessToken:string, refreshToken:string, accessExp:number, siteUrl?:string}|null}
 */
export function parseBundle(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(BUNDLE_PREFIX)) return null;
  let o;
  try {
    o = JSON.parse(raw.slice(BUNDLE_PREFIX.length).trim());
  } catch {
    return null;
  }
  if (
    typeof o !== 'object' || o === null ||
    typeof o.u !== 'string' || !o.u ||
    typeof o.a !== 'string' || !o.a ||
    typeof o.r !== 'string' || !o.r ||
    typeof o.e !== 'number'
  ) {
    return null;
  }
  const out = { webtriggerUrl: o.u, accessToken: o.a, refreshToken: o.r, accessExp: o.e };
  // `s` (site URL) is optional — older bundles predate it. Only attach it when
  // present so deepEqual against a 4-field object still holds.
  if (typeof o.s === 'string' && o.s) out.siteUrl = o.s;
  return out;
}

// --- cross-platform clipboard (mac pbpaste/pbcopy, linux xclip/xsel) ---
// Each call is timeout-bounded so a sandboxed shell can't hang the caller.

async function macClipboard(get, value) {
  if (get) {
    const { stdout } = await execFileP('pbpaste', [], { timeout: CLIP_TIMEOUT_MS });
    return stdout;
  }
  await execFileP('pbcopy', [], { input: value ?? '', timeout: CLIP_TIMEOUT_MS });
  return undefined;
}

async function linuxClipboard(tool, get, value) {
  if (get) {
    const { stdout } = await execFileP(tool, ['-selection', 'clipboard', '-o'], { timeout: CLIP_TIMEOUT_MS });
    return stdout;
  }
  await execFileP(tool, ['-selection', 'clipboard', '-i'], { input: value ?? '', timeout: CLIP_TIMEOUT_MS });
  return undefined;
}

// --- Windows clipboard (PowerShell Get-Clipboard / Set-Clipboard) ---
// `-Raw` returns the bundle as one string (the default Get-Clipboard splits on
// newlines into a string array). Set-Clipboard reads the value from stdin so
// shell quoting never breaks on special chars. `windowsHide` stops the console
// window from flashing. Bounded by CLIP_TIMEOUT_MS like the other platforms.
async function winClipboard(get, value) {
  const script = get ? 'Get-Clipboard -Raw' : '$input | Set-Clipboard';
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      reject(new Error('clipboard PowerShell timed out'));
    }, CLIP_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`clipboard PowerShell exited ${code}`)); return; }
      // PowerShell appends \r\n; parseBundle tolerates a trailing newline, but
      // drop the trailing CR/LF so the bundle is clean on Windows.
      resolve(get ? stdout.replace(/[\r\n]+$/, '') : undefined);
    });
    child.stdin.on('error', () => { /* EPIPE if the child exits early */ });
    // stdin.end() (not execFile's `input` option) — the latter never delivers
    // EOF to powershell.exe on Windows, which hangs `$input | Set-Clipboard`.
    child.stdin.end(get ? '' : (value ?? ''));
  });
}

/**
 * Classify why a clipboard tool call failed, so callers can give targeted
 * guidance instead of a generic "no clipboard":
 *  - 'no-tool':    the tool isn't installed (ENOENT) — install it, or skip.
 *  - 'no-display': the tool ran but couldn't reach the display — typical over
 *                  SSH or on a headless / host-split box (the bundle the user
 *                  copied is on a DIFFERENT machine's clipboard). NOT fixable by
 *                  installing a tool; pivot to --from-file / --from-stdin.
 *  - 'other':      anything else (timeout, unknown exit, ...).
 * Exported for testing.
 * @param {{code?:*, message?:string, stderr?:string}|null} err
 * @returns {'no-tool'|'no-display'|'other'}
 */
export function classifyClipboardError(err) {
  if (!err) return 'other';
  if (err.code === 'ENOENT') return 'no-tool';
  const text = `${err.message || ''}\n${err.stderr || ''}`.toLowerCase();
  if (
    text.includes("can't open display") ||
    text.includes('cannot open display') ||
    text.includes('could not connect to display') ||
    text.includes('authorization required') ||
    text.includes('authorization protocol') ||
    text.includes('no protocol')
  ) return 'no-display';
  return 'other';
}

const _CLIP_CODE = { 'no-tool': 'CLIPBOARD_NO_TOOL', 'no-display': 'CLIPBOARD_NO_DISPLAY' };

/**
 * Read the system clipboard. Rejects (within CLIP_TIMEOUT_MS) on unsupported
 * platforms / missing tools, with `err.code` set to one of:
 *   CLIPBOARD_NO_TOOL | CLIPBOARD_NO_DISPLAY | CLIPBOARD_ERROR | CLIPBOARD_UNSUPPORTED
 * so callers (store-token / /jira-setup) can give targeted, actionable guidance —
 * especially for the SSH / headless case where the clipboard is simply unreachable
 * and the user should switch to --from-file / --from-stdin.
 * @returns {Promise<string>}
 */
export async function getClipboard() {
  const plat = process.platform;
  const fail = (why, msg) => {
    const e = new Error(msg);
    e.code = _CLIP_CODE[why] || 'CLIPBOARD_ERROR';
    return e;
  };
  if (plat === 'darwin') {
    try { return await macClipboard(true); }
    catch (orig) { throw fail(classifyClipboardError(orig), 'macOS clipboard read failed'); }
  }
  if (plat === 'linux') {
    const errs = [];
    for (const tool of ['xclip', 'xsel']) {
      try { return await linuxClipboard(tool, true); }
      catch (e) { errs.push(e); }
    }
    // Prefer the error from a tool that EXISTED (non-ENOENT) — that's the more
    // informative cause (e.g. can't open display) — over a missing-tool ENOENT.
    const ran = errs.find((e) => e.code !== 'ENOENT') || errs[errs.length - 1];
    throw fail(classifyClipboardError(ran), 'Linux clipboard read failed');
  }
  if (plat === 'win32') {
    try { return await winClipboard(true); }
    catch { throw fail('other', 'Windows clipboard read failed'); }
  }
  const unsupported = new Error(`Clipboard read unsupported on ${plat}`);
  unsupported.code = 'CLIPBOARD_UNSUPPORTED';
  throw unsupported;
}

/**
 * Overwrite the system clipboard with `value` (used to replace a consumed bundle
 * with a harmless confirmation so it doesn't linger in clipboard history).
 * Best-effort, timeout-bounded — never throws and never blocks the caller.
 */
export async function setClipboard(value) {
  try {
    const plat = process.platform;
    if (plat === 'darwin') await macClipboard(false, value);
    else if (plat === 'linux') {
      await linuxClipboard('xclip', false, value).catch(() => linuxClipboard('xsel', false, value));
    }
    else if (plat === 'win32') await winClipboard(false, value);
  } catch {
    /* best effort — the scrub is optional hygiene */
  }
}
