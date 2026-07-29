---
name: jira-list-sessions
description: List your Codex (and Claude) sessions stored in the Jira Session Tracker.
---

# List sessions stored in Jira

## What to do

Call the `jira_list_sessions` MCP tool. Show the user the returned sessions —
for each: **sessionId**, **project**, message counts, tokens, and last-updated
time. Group or label them by `agent` (codex vs claude) if both are present.

Optionally pass `{ "projectName": "<name>" }` to filter by project.

## Notes

- Sessions are scoped to the caller (your own only) — the server identifies you
  by the OAuth token.
- This is the Codex equivalent of Claude Code's `jira_list_sessions` MCP tool.
