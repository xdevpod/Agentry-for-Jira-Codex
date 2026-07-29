---
name: jira-push-session
description: Push the current Codex session to Jira so it's stored, browsable in the Jira Agent Sessions UI, and restorable later.
---

# Push the current Codex session to Jira

Sync your current Codex session to the Jira Session Tracker.

## What to do

Call the `jira_push_session` MCP tool (from the `jira-sync` server). No arguments
are required — it auto-detects the current Codex session from
`~/.codex/sessions` and stamps it `agent=codex`. You may pass `{ "agent": "codex" }`
explicitly to be safe.

Then show the user the returned **session id** and **project**, and remind them
they can attach it to a Jira issue with `$jira-link-session`.

## Notes

- This is the Codex equivalent of Claude Code's `/jira-push-session`.
- Requires the `jira-sync` MCP server to be configured in `~/.codex/config.toml`
  and an OAuth token set up (shared with Claude Code via `$jira-setup`).
