/**
 * keychain.mjs — OS keychain storage for the OAuth access/refresh token pair.
 *
 * macOS: Keychain via the built-in `security` CLI. Linux: libsecret via
 * `secret-tool` (needs a running keyring daemon). Windows: DPAPI
 * (System.Security.Cryptography.ProtectedData, CurrentUser scope) encrypts the
 * pair into a base64 blob on disk — only this Windows user can decrypt it (the
 * same primitive git credential-manager / browser vaults use). Any platform
 * miss/error (or DPAPI unavailable) falls back to a chmod-0600 JSON file
 * (icacls-locked on Windows). The pair lives under a DEDICATED service name
 * (ai-co-work.jira-sync) so it never touches Claude Code's own keychain entry
 * and never sits in ~/.jira-sync/config.json alongside the non-secret values.
 *
 * Zero npm deps — shells out to the OS CLI only (PowerShell on Windows).
 * `opts.file` / `opts.platform` are injectable so tests exercise the file
 * fallback without the real keychain.
 *
 * Why a "borrowed-but-own" entry: Claude Code stores its OAuth tokens in the OS
 * keychain too, but under its own single shared slot — reusing it is fragile
 * (static-only, shared with OAuth, env-stripped). Our rotating tokens need their
 * own entry we can read/write freely.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { TOKENS_FILE } from './paths.mjs';

const execFileP = promisify(execFile);

export const SERVICE = 'ai-co-work.jira-sync';
export const ACCOUNT = 'tokens';
const DEFAULT_FILE = TOKENS_FILE;

// --- macOS Keychain (built-in `security` CLI) ---
async function macGet() {
  const { stdout } = await execFileP('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
  return stdout.trim();
}
async function macSet(json) {
  // -U updates if the item already exists (rotation overwrites in place).
  await execFileP('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', json, '-U']);
}
async function macDelete() {
  await execFileP('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
}

// --- Linux libsecret (`secret-tool`) ---
async function linuxGet() {
  const { stdout } = await execFileP('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
  return stdout;
}
async function linuxSet(json) {
  // Reads the secret from stdin.
  await execFileP('secret-tool', ['store', '--label=ai-co-work.jira-sync', 'service', SERVICE, 'account', ACCOUNT], { input: json });
}
async function linuxDelete() {
  await execFileP('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
}

// --- Windows DPAPI (encrypt-at-rest via PowerShell + .NET ProtectedData) ---
// Windows has no CLI for an OS keychain the way mac (`security`) / linux
// (`secret-tool`) offer — `cmdkey` can store/delete a credential but CANNOT
// read its password back, so it can't serve a rotating token pair. DPAPI
// (ProtectedData, CurrentUser scope) is the right primitive: the blob is
// encrypted with a key derived from the current Windows user's logon
// credentials, so even someone who reads the file cannot recover the tokens
// without that user session. We shell out to PowerShell (zero npm deps); each
// call is bounded by DPAPI_TIMEOUT_MS so a hung PowerShell can't block storage.
const DPAPI_TIMEOUT_MS = 15000;
// Plaintext (or base64) flows via stdin → PowerShell reads [Console]::In,
// DPAPI-protects/unprotects (CurrentUser), writes the result to stdout.
const PS_PROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$in=[Console]::In.ReadToEnd();' +
  '$b=[Text.Encoding]::UTF8.GetBytes($in);' +
  '$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($e))';
const PS_UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());' +
  '$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))';

/** Run a DPAPI PowerShell script, piping `input` via stdin and returning stdout.
 *  Uses spawn + stdin.end(input) rather than execFile's `input` option — on
 *  Windows the latter never delivers EOF to powershell.exe, so the child hangs
 *  forever reading [Console]::In and execFile times out. Manual stdin.end()
 *  (proven to deliver EOF) sidesteps that. */
function winDpapi(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      reject(new Error('DPAPI PowerShell timed out'));
    }, DPAPI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`PowerShell exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.on('error', () => { /* EPIPE if the child exits early */ });
    child.stdin.end(input);
  });
}

/** Encrypt `json` (the token pair) with DPAPI and write the base64 blob to file.
 *  Also icacls-lock the file — contents are already encrypted, but the ACL stops
 *  casual copying of the blob (defense in depth). */
async function winSet(json, file) {
  const enc = (await winDpapi(PS_PROTECT, json)).trim();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, enc, 'utf8');
  lockDownWindowsFile(file);
}

/** Read the base64 blob from file and DPAPI-decrypt it back to the json string.
 *  Returns null when nothing is stored. Throws if the blob isn't DPAPI-encrypted
 *  (so the caller falls through to the plaintext file fallback). */
async function winGet(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  const b64 = String(raw || '').trim();
  if (!b64) return null;
  return (await winDpapi(PS_UNPROTECT, b64)).trim();
}

// --- chmod-0600 file fallback ---
function fileRead(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function fileWrite(file, obj, plat = process.platform) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  if (plat === 'win32') {
    // chmod 0600 is a no-op on Windows (no POSIX permission bits). Lock the
    // file down with icacls instead: disable inheritance and grant only the
    // current user read/write. Best-effort — silent on failure (the file is
    // already written; an un-locked file is the degraded case, not a crash).
    lockDownWindowsFile(file);
  } else {
    try { chmodSync(file, 0o600); } catch { /* non-posix */ }
  }
}

/** Windows-only: restrict the token file to the current user (read/write) via
 *  icacls. No-op if we can't resolve a principal; silent on any failure. */
function lockDownWindowsFile(file) {
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : (process.env.USERNAME || '');
  if (!user) return;
  try {
    execFileSync(
      'icacls',
      [file, '/inheritance:r', '/grant:r', `${user}:(RW)`],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    /* best-effort; the file is already written */
  }
}
function fileDelete(file) {
  try { unlinkSync(file); } catch { /* ignore */ }
}

/**
 * Load the token pair, or null if none stored. Tries the OS keychain for the
 * current platform, falling back to the 0600 file on any miss/error.
 * @param {{file?: string, platform?: string}} [opts]
 * @returns {Promise<{accessToken:string,refreshToken:string,accessExp:number}|null>}
 */
export async function loadTokens(opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const plat = opts.platform || process.platform;
  try {
    if (plat === 'darwin') {
      const raw = await macGet();
      return raw ? JSON.parse(raw) : null;
    }
    if (plat === 'linux') {
      const raw = await linuxGet();
      return raw ? JSON.parse(raw) : null;
    }
    if (plat === 'win32') {
      const raw = await winGet(file);
      return raw ? JSON.parse(raw) : null;
    }
  } catch {
    // not stored yet, or CLI/PowerShell absent → fall through to the file
  }
  return fileRead(file);
}

/**
 * Persist the token pair to the OS keychain (or the 0600 file fallback).
 * @param {{accessToken:string,refreshToken:string,accessExp:number}} tokens
 * @param {{file?: string, platform?: string}} [opts]
 */
export async function saveTokens(tokens, opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const plat = opts.platform || process.platform;
  const json = JSON.stringify(tokens);
  try {
    if (plat === 'darwin') { await macSet(json); return; }
    if (plat === 'linux') { await linuxSet(json); return; }
    if (plat === 'win32') { await winSet(json, file); return; }
  } catch {
    // fall through to the file (DPAPI / PowerShell unavailable)
  }
  fileWrite(file, tokens, plat);
}

/** Remove the token pair from the OS keychain AND the fallback file. */
export async function deleteTokens(opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const plat = opts.platform || process.platform;
  try {
    if (plat === 'darwin') await macDelete();
    else if (plat === 'linux') await linuxDelete();
  } catch { /* best effort */ }
  fileDelete(file);
}
