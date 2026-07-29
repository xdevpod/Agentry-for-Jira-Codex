---
name: jira-delete-session
description: Delete one of your stored sessions from the Jira Session Tracker. Irreversible — removes the session, its linked issues, and the raw transcript.
---

# Delete a stored session

## What to do

1. Get the `sessionId`. If not given, call `jira_list_sessions` and have the
   user confirm which one to delete.
2. **Confirm with the user before proceeding** — deletion is irreversible
   (the session, its issue links, and the raw transcript are all removed).
3. Call `jira_delete_session` with `{ "sessionId": "<id>" }`.
4. Report the result; on failure, surface the error.

## Notes

- Only your own sessions can be deleted (the server identifies you by the
  OAuth token; a non-owner's session returns 404 with no existence leak).
- Deleting a session also removes its issue links, so it disappears from
  Project Pages and Issue Panels.
