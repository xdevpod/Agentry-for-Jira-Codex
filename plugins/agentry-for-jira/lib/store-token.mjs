#!/usr/bin/env node
/**
 * store-token.mjs — store the OAuth token pair + web trigger URL.
 *
 * Four modes. ALL keep tokens out of the Claude transcript: the bundle bytes go
 * straight to config.json / keychain, and only `✅ Saved` + the non-secret URL
 * are printed. (This plugin syncs the raw transcript into Jira, so a token that
 * entered stdout/argv would leak.)
 *
 *   node store-token.mjs --from-clipboard        ← preferred on a local desktop.
 *     Reads a setup bundle the user copied from the Jira token card, stores it,
 *     then overwrites the clipboard with a harmless string.
 *
 *   node store-token.mjs --from-file <path>      ← preferred over SSH / headless,
 *     or whenever the clipboard is unreachable. Reads the bundle from a file on
 *     THIS host (e.g. `scp` it over, or paste into `cat > /tmp/bundle` in your
 *     own terminal), stores it, then SHREDS the file. If shredding fails (the
 *     file isn't owned by this user) it prints a ⚠️ — delete it manually, since
 *     it still holds live tokens.
 *
 *   node store-token.mjs --from-stdin            ← pipe the bundle in, e.g.
 *     `ssh host -- node store-token.mjs --from-stdin < bundle.txt`. Nothing is
 *     echoed or written to disk, so there is nothing to shred.
 *
 *   node store-token.mjs                         ← interactive fallback (hidden
 *     prompts for each of the 5 values). Use only when you have no bundle.
 *
 * The bundle is a SECRET. Run store-token in your own terminal (or via
 * /jira-setup); never paste the bundle into the Claude chat.
 */
import readline from 'node:readline';
import { readFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveConfigFile, loadConfigFile } from './secrets.mjs';
import { saveTokens } from './keychain.mjs';
import { parseBundle, getClipboard, setClipboard } from './token-bundle.mjs';

/**
 * Persist a full setup: webtriggerUrl + siteUrl (+ accessExp) → config.json
 * (non-secret); access/refresh → OS keychain. Returns a sanitized summary
 * (no secrets). `configPath` / `tokenOpts` are injectable so tests use tmp dirs
 * and never touch the real home dir / keychain.
 */
export async function storeAll(
  { webtriggerUrl, siteUrl, accessToken, refreshToken, accessExp },
  { configPath, tokenOpts } = {},
) {
  const existing = loadConfigFile(configPath);
  saveConfigFile({
    ...existing,
    ...(webtriggerUrl ? { JIRA_WEBTRIGGER_URL: webtriggerUrl } : {}),
    ...(siteUrl ? { JIRA_SITE_URL: siteUrl } : {}),
    ...(accessExp ? { JIRA_ACCESS_EXP: String(accessExp) } : {}),
  }, configPath);
  await saveTokens({ accessToken, refreshToken, accessExp }, tokenOpts);
  return {
    webtriggerUrl: webtriggerUrl || existing.JIRA_WEBTRIGGER_URL || '(unchanged)',
    siteUrl: siteUrl || existing.JIRA_SITE_URL || '(unchanged)',
  };
}

/** Read a secret with hidden echo. */
function ask(rl, q) {
  return new Promise((resolve) => {
    const original = rl._writeToOutput;
    rl._writeToOutput = () => {}; // suppress echo
    rl.question(q, (ans) => {
      rl._writeToOutput = original;
      process.stdout.write('\n');
      resolve(ans.trim());
    });
  });
}

async function interactive(deps) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  console.log('Claude Code ↔ Forge Session Tracker setup (interactive)');
  const webtriggerUrl = await ask(rl, 'Web Trigger URL: ');
  const siteUrl = await ask(rl, 'Jira site URL (e.g. https://x.atlassian.net): ');
  const accessToken = await ask(rl, 'Access token: ');
  const refreshToken = await ask(rl, 'Refresh token: ');
  const accessExp = Number((await ask(rl, 'Access expiry (epoch ms): ')).trim()) || 0;
  rl.close();
  return storeAll({ webtriggerUrl, siteUrl, accessToken, refreshToken, accessExp }, deps);
}

// --- bundle sources (clipboard / file / stdin) ---

/** Read + parse a bundle from a file. Throws a friendly, user-facing error if
 *  the file is missing or doesn't contain a valid bundle. Pure wrt config/keychain. */
export function readBundleFromFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Bundle file not found: ${filePath}`);
    throw new Error(`Could not read bundle file ${filePath}: ${e.message}`);
  }
  const bundle = parseBundle(raw);
  if (!bundle) {
    throw new Error(
      `${filePath} does not contain a valid setup bundle. Re-copy the bundle from the Jira "My Agent Sessions" page ("Copy setup bundle") and recreate the file.`
    );
  }
  return bundle;
}

/** Read + parse a bundle from a stream (defaults to stdin). Throws a friendly
 *  error on an invalid/empty bundle, and immediately if nothing is piped (TTY). */
export async function readBundleFromStdin(stream = process.stdin) {
  if (stream.isTTY) {
    throw new Error(
      'Nothing is piped to stdin. Pipe a bundle (`... --from-stdin < bundle.txt`), or use --from-file / --from-clipboard.'
    );
  }
  const raw = await new Promise((resolveRead, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { data += c; });
    stream.on('end', () => resolveRead(data));
    stream.on('error', reject);
  });
  const bundle = parseBundle(raw);
  if (!bundle) {
    throw new Error(
      'No valid setup bundle on stdin. Pipe a bundle in, e.g. `ssh host -- node store-token.mjs --from-stdin < bundle.txt`.'
    );
  }
  return bundle;
}

/** Turn a clipboard `err.code` (from token-bundle.getClipboard) into targeted,
 *  actionable guidance. Exported for testing + reuse by /jira-setup. */
export function clipboardUnavailableMessage(code) {
  switch (code) {
    case 'CLIPBOARD_NO_TOOL':
      return [
        'No clipboard tool found on this host.',
        '  • Install one (Linux: `sudo apt-get install -y xclip`), OR',
        '  • Skip the clipboard: save the bundle to a file on THIS host and run',
        '    `store-token.mjs --from-file <path>` (recommended over SSH / headless).',
      ].join('\n');
    case 'CLIPBOARD_NO_DISPLAY':
      return [
        'A clipboard tool is installed but cannot reach the display — typical over',
        'SSH or on a headless / host-split box (the bundle you copied is on a different',
        "machine's clipboard). Save the bundle to a file on THIS host and run",
        '`store-token.mjs --from-file <path>`, or pipe it: `--from-stdin < bundle.txt`.',
      ].join('\n');
    case 'CLIPBOARD_UNSUPPORTED':
      return [
        'Clipboard read is unsupported on this platform.',
        'Use `--from-file <path>` or `--from-stdin` instead.',
      ].join('\n');
    default:
      return [
        'Clipboard read failed.',
        'Use `--from-file <path>` or `--from-stdin` instead, or run with no flags',
        'for interactive entry.',
      ].join('\n');
  }
}

async function fromClipboard(deps) {
  let clip;
  try {
    clip = await getClipboard();
  } catch (e) {
    throw new Error(clipboardUnavailableMessage(e?.code));
  }
  const bundle = parseBundle(clip);
  if (!bundle) {
    throw new Error(
      'No setup bundle on the clipboard. On the Jira "My Agent Sessions" page, click "Copy setup bundle" on the token card, then re-run. (Over SSH / headless, use --from-file or --from-stdin instead.)'
    );
  }
  // Store only — the clipboard scrub happens in main() AFTER we report success,
  // so a slow/blocked pbcopy can never hide the ✅ from the user.
  return storeAll(bundle, deps);
}

/**
 * Best-effort destroy of a file holding live tokens: `shred -u`, then unlink.
 * Returns true if the file is gone afterwards, false if it still exists (e.g.
 * not owned by this user — common when the bundle file was created by a
 * different user, as on a host-split box). Never throws.
 */
export function shredFile(filePath) {
  if (!existsSync(filePath)) return true;
  let gone = false;
  try { spawnSync('shred', ['-u', filePath], { stdio: 'ignore' }); gone = !existsSync(filePath); } catch { /* shred missing */ }
  if (!gone) {
    try { unlinkSync(filePath); gone = !existsSync(filePath); } catch { /* not ours to delete */ }
  }
  return gone;
}

async function main() {
  const argv = process.argv.slice(2);
  const fromClip = argv.includes('--from-clipboard');
  const fromStdin = argv.includes('--from-stdin');
  const fileIdx = argv.indexOf('--from-file');
  const hasFile = fileIdx !== -1;

  let summary;
  if (fromClip + fromStdin + (hasFile ? 1 : 0) > 1) {
    console.error('❌ Pick ONE source: --from-clipboard, --from-file <path>, or --from-stdin.');
    process.exit(2);
  }

  if (fromClip) {
    summary = await fromClipboard();
  } else if (fromStdin) {
    summary = await storeAll(await readBundleFromStdin());
  } else if (hasFile) {
    const filePath = argv[fileIdx + 1];
    if (!filePath || filePath.startsWith('--')) {
      console.error('❌ --from-file requires a path argument.');
      process.exit(2);
    }
    summary = await storeAll(readBundleFromFile(filePath));
    // The file holds live tokens — destroy it now that storage succeeded.
    if (!shredFile(filePath)) {
      console.error(
        `⚠️ Could not remove ${filePath} (not owned by this user?). Delete it manually — it contains live tokens.`
      );
    }
  } else {
    summary = await interactive();
  }

  // Report success FIRST — the clipboard scrub below is optional hygiene and must
  // never block the user from seeing that storage succeeded.
  console.log(`✅ Saved. Web Trigger URL → ~/.agentry-for-jira/config.json; token pair → OS keychain.`);
  console.log(`   URL: ${summary.webtriggerUrl}`);
  console.log(`   Site: ${summary.siteUrl}`);
  console.log('Back in Claude Code, finish /jira-setup (or say "done") to verify the connection.');
  if (fromClip) {
    // Overwrite the consumed bundle so it doesn't linger in clipboard history.
    // Timeout-bounded in token-bundle.mjs, so this can't hang.
    await setClipboard('Agentry for Jira token stored ✓');
  }
}

// Run only when invoked directly (not when imported by tests).
const _isEntry = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (_isEntry) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
