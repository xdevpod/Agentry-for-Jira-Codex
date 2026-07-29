---
name: jira-unlink-session
description: Unlink a stored session from a Jira issue (removes the session-link only; the session itself is kept).
---

# Unlink a session from a Jira issue

## What to do

1. Get the `sessionId` and `linkId`. The `linkId` has the form
   `<sessionId>::<issueKey>` (e.g. `abc-123::PROJ-456`). If you only know the
   issue key, derive it as `<sessionId>::<issueKey>`. To discover existing
   links, call `jira_list_sessions` / `jira_get_session`.
2. Call `jira_unlink_session` with `{ "sessionId": "<id>", "linkId": "<id>::<KEY>" }`.
3. Report the result. On success the session no longer appears on that issue's
   Agent Sessions panel. On failure, surface the error.

## Notes

- Only the session's owner can unlink it (the server identifies you by the
  OAuth token; a non-owner's link returns 403).
- Unlinking removes the session-link only — the session and its transcript
  stay in the tracker. To delete the session itself, use `jira_delete_session`.
- Idempotent: unlinking a non-existent link still returns success.
