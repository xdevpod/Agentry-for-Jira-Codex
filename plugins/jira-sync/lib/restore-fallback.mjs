/**
 * Convert parsed session JSON back to Claude-style JSONL lines for restore.
 * This is a fallback path when the raw transcript is unavailable.
 */
export function convertToJsonl(sessionData) {
  const lines = [];
  const sid = sessionData.sessionId;
  let seq = 0;
  const uuid = () => `${sid}-r-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  lines.push(JSON.stringify({
    type: 'mode',
    mode: 'normal',
    sessionId: sid,
  }));

  const toolUsesByName = new Map();
  for (const ti of sessionData.toolInteractions || []) {
    if (ti.type !== 'tool_use' || !ti.toolName) continue;
    const queue = toolUsesByName.get(ti.toolName) || [];
    queue.push(ti);
    toolUsesByName.set(ti.toolName, queue);
  }

  const timeline = [
    ...(sessionData.humanMessages || []).map((msg, index) => ({
      kind: 'user',
      timestamp: msg.timestamp,
      index,
      msg,
    })),
    ...(sessionData.assistantMessages || []).map((msg, index) => ({
      kind: 'assistant',
      timestamp: msg.timestamp,
      index,
      msg,
    })),
  ];

  const tsValue = (value) => {
    const ms = Date.parse(value || '');
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };

  timeline.sort((a, b) => {
    const ta = tsValue(a.timestamp);
    const tb = tsValue(b.timestamp);
    if (ta !== tb) return ta - tb;
    if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
    return a.index - b.index;
  });

  for (const entry of timeline) {
    if (entry.kind === 'user') {
      lines.push(JSON.stringify({
        type: 'user',
        uuid: uuid(),
        timestamp: entry.msg.timestamp,
        message: { role: 'user', content: entry.msg.text },
      }));
      continue;
    }

    const contentBlocks = [{ type: 'text', text: entry.msg.text || '' }];
    for (const toolName of entry.msg.toolsUsed || []) {
      const queue = toolUsesByName.get(toolName) || [];
      const ti = queue.shift();
      if (ti) {
        contentBlocks.push({
          type: 'tool_use',
          id: ti.toolId || uuid(),
          name: ti.toolName,
          input: ti.input || {},
        });
      }
    }

    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: uuid(),
      timestamp: entry.msg.timestamp,
      message: { role: 'assistant', content: contentBlocks },
    }));
  }

  return lines;
}
