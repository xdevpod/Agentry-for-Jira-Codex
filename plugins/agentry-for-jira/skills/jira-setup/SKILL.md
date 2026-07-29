---
name: jira-setup
description: Set up (and rotate) the Jira session-sync OAuth token + web-trigger URL for this Codex terminal. Reads a Jira setup bundle straight from the clipboard (elevated), stores it, then verifies the connection once. If the clipboard has no valid bundle (or is unreachable over SSH/headless/sandbox), asks before falling back to a file/stdin. Tokens never enter the chat.
---

# Set up Jira session-sync for this Codex terminal

Setup **and rotation** for the Jira session-sync plugin. Auth is an **OAuth 2.1
app-scoped token pair** (access + refresh, auto-rotating). Jira CRUD
(create-issue / comment / JQL) is NOT part of this plugin — use the official
Atlassian plugin.

This shares the same OAuth token + `~/.agentry-for-jira/` config as Claude Code
(the keychain slot is path-independent), so either side can (re)configure it.

**The token pair is a SECRET. It must NEVER be pasted into this chat** — this
plugin syncs the raw Codex transcript into Jira once configured, so a pasted
token would leak. Tokens move
clipboard (or file/stdin) → `store-token.mjs` → OS keychain; the only thing
that reaches this transcript is `✅ Saved`.

## Flow

Direct: **read the clipboard, store the bundle, verify once.** No up-front check
of the stored token, and no separate connection test first — `$jira-setup` just
stores whatever valid bundle is on the clipboard, then confirms it works.
Re-running overwrites whatever is currently stored (the verify step shows which
account you ended up connected as, so the change is never silent).

1. **Store from the clipboard (elevated)** — the user should have already copied
   a setup bundle from Jira (open the **"My Agent Sessions"** page → **Generate
   token** → **📋 Copy setup bundle**). **You (Codex) store the bundle YOURSELF
   via your shell tool — run it ELEVATED (request the user's approval for an
   elevated run).** The user only copies the bundle; do NOT ask them to run
   anything by hand. (This matches Claude Code's `/jira-setup`, which runs the
   very same script automatically.)
   **Why elevated:** Codex's default sandbox isolates the host pasteboard, so a
   sandboxed `store-token.mjs --from-clipboard` fails with `No clipboard
   available` even though the user DID copy the bundle — elevation restores
   `pbpaste` (macOS) / `xclip` (Linux) access. Resolve the installed plugin root
   (cached under a versioned dir, newest wins) and run:
   ```sh
   PLUGIN=$(find "${CODEX_HOME:-$HOME/.codex}/plugins/cache/agentry-for-jira/agentry-for-jira" \
     -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)
   node "$PLUGIN/lib/store-token.mjs" --from-clipboard
   ```
   The script reads the clipboard ITSELF and writes the keychain, printing only
   `✅ Saved` + the non-secret URL. **Never `pbpaste`/cat/echo the clipboard or
   tokens yourself** — only `✅ Saved` should reach this transcript.
   - **`✅ Saved`** → go to step 2.
   - **"No setup bundle on the clipboard"** → the clipboard doesn't hold a valid
     bundle. Ask the user to click **Copy setup bundle** on the Jira "My Agent
     Sessions" page (a FRESH one — if they revoked the old device, this new one
     is its replacement), then re-run this step. Or, over SSH/headless where the
     clipboard is unreachable, switch to the file path below.
   - **`--from-clipboard` still fails even when elevated** → the error message
     names the cause: `No clipboard tool found` (install `xclip`/`xsel`) vs
     `cannot reach the display` — the latter is typical over **SSH or on a
     headless / host-split host**, where the bundle the user copied is on a
     different machine's (or a different user's) pasteboard and is simply
     unreachable. Don't keep retrying the clipboard; pivot to a **file** (the
     bundle stays out of this transcript either way — only `✅ Saved` reaches
     here):
     1. Have the user save the bundle to a file **on THIS host** in their OWN
        terminal (not here) — `scp` it over, or `cat > /tmp/jira-bundle` then
        paste the bundle and Ctrl+D; `chmod 644 /tmp/jira-bundle` if a different
        user must read it (the Codex process may run as a different user than
        the desktop).
     2. Then you (Codex) store it via the same `$PLUGIN` (elevated, as above):
        ```sh
        node "$PLUGIN/lib/store-token.mjs" --from-file /tmp/jira-bundle
        ```
        It stores the bundle and **shreds the file**; if shredding fails (the
        file isn't owned by this user) it prints `⚠️ Could not remove …` — tell
        the user to delete it manually, since it holds live tokens. Or pipe
        instead: `--from-stdin < /tmp/jira-bundle` (nothing touches disk).

2. **Verify once** with `jira_test_connection` (the `agentry-for-jira` MCP tool —
   web-trigger `whoami`):
   - **200** → ✅ connected as `<email>` (device `<familyId>`).
   - **fail** → most often a stale clipboard bundle (have them copy a fresh one
     and redo step 1), or the Forge app needs `forge install --upgrade` (the
     `token-family` entity). Diagnose and retry; don't leave the user
     unconfigured.

## Notes

- No up-front connection test by design: `$jira-setup` stores the clipboard
  bundle first, then verifies. The single verify at step 2 surfaces a dead or
  stale bundle instead of silently storing one.
- Re-running `$jira-setup` always overwrites the stored config with the clipboard
  bundle (no pre-check, no "already working" short-circuit). The step-2 verify
  shows the resulting account, so switching Jira site or account is visible, not
  silent.
- If the clipboard path is unavailable even when elevated (SSH, headless, or the
  bundle is on a different user's pasteboard — the Codex process may run as a
  different user than the desktop), use `--from-file <path>` or `--from-stdin`
  (step 1). The `store-token.mjs` error names the cause (`No clipboard tool
  found` vs `cannot reach the display`) and points at the same fix. The
  interactive fallback (`store-token.mjs` with no flags, 5 hidden prompts) is a
  last resort for when no bundle is available at all — the user runs it in their
  OWN terminal, never pasting tokens into this chat.
- Never echo the access/refresh token. The bundle is app-scoped + per-device
  revocable from the Jira UI, but keep it out of transcripts regardless.
- This is the Codex equivalent of Claude Code's `/jira-setup`.
