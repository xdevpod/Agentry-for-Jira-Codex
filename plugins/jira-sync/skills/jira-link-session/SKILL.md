---
name: jira-link-session
description: Link a pushed session to a Jira issue so it appears on that issue's Agent Sessions panel.
---

# Link a session to a Jira issue

## What to do

1. Get the `sessionId`. If not provided by the user, use the one from a recent
   `$jira-push-session`, or call `jira_list_sessions` and confirm.
2. Get the `issueKey` from the user (e.g. `PROJ-123`).
3. Call `jira_link_session` with `{ "sessionId": "<id>", "issueKey": "<KEY>" }`.
4. Show the returned link id. If a Jira site URL is configured, also show the
   clickable `/browse/<KEY>` link.

## Notes

- Linking is what places a session onto a Project Page / Issue Panel in Jira —
  without it, the session is stored but not visible on any issue.
- Optional fields: `context` (`"auto"` / `"manual"` / `"task-start"` /
  `"task-end"`) and a free-text `note`.
