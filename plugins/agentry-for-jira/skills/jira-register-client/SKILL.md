---
name: jira-register-client
description: Register this Codex terminal in Jira so it appears in "My AI Clients" (and refresh its last-seen info).
---

# Register this Codex terminal in Jira

Register (or refresh) this machine as a Codex AI terminal in the Jira Session
Tracker, so it shows up under "My AI Clients".

## What to do

Call the `jira_register_client` MCP tool (from the `agentry-for-jira` server). It
derives a stable clientId locally from the machine + the Codex client type (no
secrets are sent) and upserts the terminal server-side. Re-running is idempotent
— it just refreshes `lastSeenAt` and basic info.

You may pass `{ "agent": "codex" }` explicitly; otherwise it auto-detects.

Then show the user the returned clientId, display name, host, and version.

## Notes

- This is the Codex equivalent of Claude Code's `/jira-register-client`.
- Registration is what makes a terminal manageable in Jira's "My AI Clients"
  page (list / inspect / clone-detection). Without it, Codex pushes
  still work, but the terminal itself isn't listed.
