---
name: jira-setup
description: Set up (and rotate) the Jira session-sync OAuth token + web-trigger URL for this Codex terminal. Verifies the stored token first; if it's missing or dead, stores a fresh one from a Jira setup bundle via the clipboard, or via a file/stdin when the clipboard is unreachable (SSH, headless, sandbox). Tokens never enter the chat.
---

# Set up Jira session-sync for this Codex terminal

Setup **and rotation** for the Jira session-sync plugin. Auth is an **OAuth 2.1
app-scoped token pair** (access + refresh, auto-rotating). Jira CRUD
(create-issue / comment / JQL) is NOT part of this plugin — use the official
Atlassian plugin.

This shares the same OAuth token + `~/.agentry-for-jira/` config as Claude Code (the
keychain slot is path-independent). If the user already configured it from
Claude Code, this skill usually just verifies and does nothing.

**The token pair is a SECRET. It must NEVER be pasted into this chat** — this
plugin syncs the raw Codex transcript into Jira once configured, so a pasted
token would leak. Tokens move
clipboard (or file/stdin) → `store-token.mjs` → OS keychain; the only thing
that reaches this transcript is `✅ Saved`.

## Flow

The key rule: **verification decides whether we (re)store.** A stored token that
fails verification is dead (revoked in Jira, or refresh-expired) and MUST be
replaced — never just report the failure and stop.

1. **Verify the current state FIRST** by calling the `jira_test_connection` MCP
   tool (from the `agentry-for-jira` server — it hits the web-trigger `whoami`):
   - **200 / "Authenticated"** → already configured and working. Tell the user
     it's ready, and
     **stop — do NOT store anything** (nothing to replace).
   - **401 / fail / "not configured"** → either no token yet, or the stored
     token is dead. This is initial setup OR a **rotation**: fall through to
     step 2 to store/replace it. (Do not stop at the error.)

2. **Store/replace the token from a fresh bundle** (run this for initial setup
   OR for rotation):
   - Tell the user — do NOT have them paste anything here — to open the
     **"My Agent Sessions"** page in Jira, click **Generate token**, then
     **📋 Copy setup bundle** (a FRESH one — if they revoked the old device,
     this new one is its replacement).
   - **You (Codex) then store the bundle YOURSELF via your shell tool — run it
     ELEVATED (request the user's approval for an elevated run).** The user only
     copies the bundle; do NOT ask them to run anything by hand. (This matches
     Claude Code's `/jira-setup`, which runs the very same script automatically.)
     **Why elevated:** Codex's default sandbox isolates the host pasteboard, so
     a sandboxed `store-token.mjs --from-clipboard` fails with
     `No clipboard available` even though the user DID copy the bundle —
     elevation restores `pbpaste` (macOS) / `xclip` (Linux) access. Resolve the
     installed plugin root (cached under a versioned dir, newest wins) and run:
     ```sh
     PLUGIN=$(find "${CODEX_HOME:-$HOME/.codex}/plugins/cache/agentry-for-jira/agentry-for-jira" \
       -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)
     node "$PLUGIN/lib/store-token.mjs" --from-clipboard
     ```
     The script reads the clipboard ITSELF and writes the keychain, printing
     only `✅ Saved` + the non-secret URL. **Never `pbpaste`/cat/echo the
     clipboard or tokens yourself** — only `✅ Saved` should reach this
     transcript.
   - **If `--from-clipboard` still fails even when elevated**, the error message
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
   - **Last resort** (no bundle file available at all): the user runs
     `node "$PLUGIN/lib/store-token.mjs"` (interactive hidden prompts) in their
     OWN terminal — never have them paste tokens into this chat.
   - "No setup bundle on the clipboard" → the user hasn't clicked **Copy setup
     bundle** yet (or copied something else). Have them click it and re-run.

3. **Verify again** with `jira_test_connection`:
   - **200** → ✅ connected as `<email>` (device `<familyId>`).
   - **fail** → most often a stale clipboard bundle (have them copy a fresh one
     and redo step 2), or the Forge app needs `forge install --upgrade` (the
     `token-family` entity). Diagnose and retry; don't leave the user
     unconfigured.

## Notes

- Rotation is normal here: revoking a device in Jira then re-running
  `$jira-setup` should land on step 2 and replace the keychain token. If you
  ever find yourself reporting "token expired" without having offered to replace
  it, you skipped step 2 — go back and run it.
- If the clipboard path is unavailable even when elevated (SSH, headless, or the
  bundle is on a different user's pasteboard — the Codex process may run as a
  different user than the desktop), use `--from-file <path>` or `--from-stdin`
  (see step 2). The `store-token.mjs` error names the cause (`No clipboard tool
  found` vs `cannot reach the display`) and points at the same fix. The
  interactive fallback (no flags, 5 hidden prompts) is a last resort for when no
  bundle is available at all.
- Never echo the access/refresh token. The bundle is app-scoped + per-device
  revocable from the Jira UI, but keep it out of transcripts regardless.
- This is the Codex equivalent of Claude Code's `/jira-setup`.
