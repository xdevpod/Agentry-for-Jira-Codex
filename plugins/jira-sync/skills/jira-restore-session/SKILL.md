---
name: jira-restore-session
description: Restore a previously pushed session from Jira to this Codex terminal and resume it with `codex resume`. A Codex session is restored natively; a Claude session is auto-converted to a Codex rollout (cross-agent handoff) — the tool detects the source, so just give it a sessionId.
---

# Restore a session from Jira (resume in Codex)

Pull a session back from Jira to this machine and resume it in Codex. The source
can be **Codex** (native restore) or **Claude** (auto-converted to a Codex
rollout). **The tool detects the source itself from the session metadata — you do
NOT need to ask the user which it is, and you do NOT need to ask whether to
convert.**

## What to do

1. **Get the sessionId.** If the user didn't supply one, call `jira_list_sessions`
   (it shows each session's agent + summary) and have the user pick one. That's
   the only thing you need from the user — the sessionId.
2. **`cd` into the project directory** you want to continue in. The restored
   session's working dir is recorded as the current directory (cross-machine: the
   path may differ from where it originally ran).
3. **Call `jira_restore_session` with `targetAgent: "codex"`:**
   ```json
   { "sessionId": "<id>", "targetAgent": "codex" }
   ```
   **Always pass `targetAgent: "codex"` from Codex — do not ask the user.** It is
   safe for any source: native restore if the session is Codex, automatic
   Claude→Codex conversion if it's Claude.
4. **Report the result.** The tool returns the written path and the exact resume
   command — relay both to the user.

## What the tool result tells you (and the user)

- `✅ Session <id> restored` — plus either `🔄 Converted Claude → Codex rollout`
  (Claude source) or `🎯 Full fidelity (original JSONL)` (Codex source).
- `📇 Registered in Codex session index` — the SQLite row was inserted, so
  `codex resume <id>` will find it. If you see `⚠️ Could not register in Codex
  index` instead, the MCP server's Node is < 22.5 (`node:sqlite` unavailable) —
  the rollout file was still written, but resume may not find it until Node is
  upgraded.
- `Resume with: codex resume <id>`.

## Notes

- **Handoff ≠ replay** (Claude→Codex): tool calls (Edit/Bash/…) become one-line
  `[bridged tool call: …]` prose footnotes — the model understands prior work but
  can't undo/re-execute it. Reasoning/thinking is not carried over.
- Codex ≥0.128 finds sessions via its SQLite index (`~/.codex/state_5.sqlite`
  `threads`), not by scanning rollout files — the tool registers the row for you
  (idempotent; re-restoring won't create duplicates).
- If a local rollout with the same thread_id already exists, the restored file is
  a *separate* file (`rollout-<id>.jsonl`). To make `codex resume <id>` load the
  restored one unambiguously, move the original aside first.
- Claude Code has its own `/jira-restore-session` command (restores to Claude);
  this skill is the Codex side.
