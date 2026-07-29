/**
 * Extract Claude Code's AI-generated session title from a transcript.
 *
 * Claude Code writes the title as a dedicated JSONL line:
 *   {"type":"ai-title","aiTitle":"Review issue APDEVIMP-54","sessionId":"…"}
 *
 * It is generated asynchronously after the first turn and rewritten as the
 * topic evolves, so the LAST occurrence is the current title. This is the exact
 * string the `claude /resume` picker displays — which makes it the precise cue
 * for finding a restored session (replacing the older first-prompt heuristic,
 * which only matched the topic, not the wording).
 *
 * @param {string} jsonl - Raw JSONL transcript (one JSON event per line).
 * @returns {string} The last aiTitle, or '' when none exists (very short
 *                   sessions, or non-Claude transcripts such as Codex rollouts).
 */
export function extractAiTitle(jsonl) {
  if (!jsonl) return '';
  let title = '';
  for (const raw of jsonl.split('\n')) {
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (entry && entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle) {
      title = entry.aiTitle;
    }
  }
  return title;
}
