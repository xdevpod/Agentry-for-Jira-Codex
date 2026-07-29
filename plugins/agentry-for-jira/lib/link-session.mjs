/**
 * link-session.mjs — pure jira_link_session tool logic.
 *
 * Extracted from mcp-server/index.mjs so the user-facing result/error formatting
 * is unit-testable without the stdio MCP entry point. Mirrors the dependency-
 * injection convention used by lib/push.mjs (`deps: { send, ... }`): the forge
 * client + siteUrl are passed in, never constructed here.
 *
 * The Forge app validates the issue exists before linking (APDEVIMP-47) and the
 * ForgeClient surfaces a non-2xx as an Error with `.status` + `.body`. We turn a
 * 404 { error: 'ISSUE_NOT_FOUND' } into a clear, actionable error instead of a
 * silent "✅ linked" — that silent success on a non-existent key is the bug.
 */

/** Build a /browse/<key> URL, or null if either piece is missing. Mirrors the
 *  helper in mcp-server/index.mjs (kept local to avoid coupling this lib to the
 *  MCP entry module). */
function browseUrl(siteUrl, issueKey) {
  if (!siteUrl || !issueKey) return null;
  return `${siteUrl.replace(/\/+$/, '')}/browse/${issueKey}`;
}

/**
 * @param {object} params - { sessionId, issueKey, context?, note? }
 * @param {object} deps
 * @param {object} deps.forge - ForgeClient (or stub) with `.linkSession(...)`.
 * @param {string} [deps.siteUrl] - Jira site origin, for a clickable issue link.
 * @returns {Promise<{ content: Array, isError?: boolean }>} MCP tool result.
 */
export async function linkSessionTool(params, deps) {
  const { sessionId, issueKey, context, note } = params;
  const forge = deps.forge;
  const siteUrl = deps.siteUrl;

  try {
    const result = await forge.linkSession(sessionId, issueKey, { context, note });
    const link = browseUrl(siteUrl, issueKey);
    const issueRef = link ? `[${issueKey}](${link})` : issueKey;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Session ${sessionId} linked to ${issueRef}\n` +
            `Link ID: ${result.linkId}\n` +
            `Context: ${context || 'manual'}`,
        },
      ],
    };
  } catch (err) {
    const status = err?.status;
    const serverCode = err?.body?.error;
    const detail = err?.body?.message || err?.message || 'unknown error';
    if (status === 404 || serverCode === 'ISSUE_NOT_FOUND') {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Could not link to ${issueKey}: that issue does not exist or is not visible to the app.\n` +
              `Check the key (format PROJECT-NUMBER, e.g. APDEVIMP-47) or create the issue first, then re-run /jira-link-session.\n` +
              `Details: ${detail}`,
          },
        ],
        isError: true,
      };
    }
    const hint = err?.code === 'REGENERATE'
      ? '\nTip: re-run /jira-setup to refresh the token.'
      : '';
    return {
      content: [
        { type: 'text', text: `❌ Failed to link session ${sessionId} to ${issueKey}: ${detail}${hint}` },
      ],
      isError: true,
    };
  }
}
