---
name: jira-backup-codex
description: Back up this Codex terminal's config and custom assets (config.toml, custom agents/skills/rules, hooks, AGENTS.md, and ~/.codex/memories) to Jira — you pick which categories to include from a numbered checklist; secrets are redacted locally first, each category stored separately and attributed to this Codex terminal.
---

# Back up this Codex terminal to Jira

Back up what this Codex terminal keeps under `~/.codex` (except secrets and
session/runtime state) to the Jira Session Tracker. The user **chooses which
categories to include** from a numbered checklist each run — it is not
all-or-nothing. Everything is stored alongside this terminal's record and
viewable under "My AI clients".

## Categories (canonical order + `categories` id)

1. **Config** — `config` (`~/.codex/config.toml`: settings, MCP servers,
   marketplaces, installed plugins)
2. **Custom assets**
   - **Agents** — `agents` (`~/.codex/agents/*.toml`)
   - **Skills** — `skills` (`~/.codex/skills/<name>/**`, built-in `.system` excluded)
   - **Rules** — `rules` (`~/.codex/rules/**`)
   - **Hooks** — `hooks` (`~/.codex/hooks.json`)
3. **Memory**
   - **AGENTS.md** — `guidance` (instruction memory)
   - **Local memories** — `local-memory` (`~/.codex/memories/**`, per file)

Never sent: `auth.json` (credentials), `sessions/`, `history.jsonl`, the root
`memories_*.sqlite` cache, logs, and other machine-local / rebuildable state.

## What to do

1. **Preview what's available.** Call the `jira_backup_codex` MCP tool (from the
   `agentry-for-jira` server) with `{ "dryRun": true }` and NO `categories`. It collects
   every category from `$CODEX_HOME` (default `~/.codex`), redacts secrets locally,
   and returns a per-category preview (files, size, redactions). This tells you
   which categories exist on this terminal.

2. **Present a NUMBERED checklist and let the user choose.** Print ONLY the
   categories that are present, numbered sequentially in the canonical order
   above, grouped under **Config / Custom assets / Memory** headings. Put the
   file/size hint after each item. End with the reply instruction. Use exactly
   this shape (drop any group whose items are all absent):

   ```
   Which categories to back up? Reply with the numbers (for example "1 3 4"), "all", or "none".

   Config
     1. Config — config.toml
   Custom assets
     2. Agents — 3 files
     3. Rules — 1 file
   Memory
     4. AGENTS.md
     5. Local memories — 12 files
   ```

   Keep your own number → `categories` id mapping (here 1→config, 2→agents,
   3→rules, 4→guidance, 5→local-memory). Wait for the user's reply, then:
   - a list of numbers → those categories;
   - **all** → every present category;
   - **none** (or an empty reply) → stop without uploading, and say so.

3. **Confirm once.** The upload sends data to an external service, so confirm
   (yes / no) before uploading, listing the chosen categories by name.

4. **Upload the selection.** Call `jira_backup_codex` WITHOUT `dryRun` and with
   `{ "categories": [<chosen ids>] }` (omit `categories` only for "all"). The tool
   registers this Codex terminal and upserts each chosen category to its own store;
   unselected categories are left untouched (each is a separate blob), and an
   unchanged category short-circuits. Report the per-category result (created /
   updated / unchanged + revision).

## Notes

- The backup is download-only in Jira (view / download) — it never writes back to
  your `~/.codex` files automatically.
- Requires the `agentry-for-jira` MCP server configured in `~/.codex/config.toml` and an
  OAuth token set up (shared with Claude Code via `$jira-setup`). On an
  expired/revoked token the tool errors with a `REGENERATE` hint — re-run
  `$jira-setup`.
