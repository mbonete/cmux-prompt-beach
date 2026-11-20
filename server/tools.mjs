// Tool-call categories for the little icon that pops up over a working agent.
// The names are Claude Code's built-in tool names as they appear in hook payloads
// (`tool_name` on PreToolUse) and in transcripts (`tool_use.name`).

export const TOOL_CATEGORIES = ['edit', 'command', 'search', 'web', 'read', 'other'];

const BY_NAME = new Map([
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Bash', 'command'],
  ['BashOutput', 'command'],
  ['KillShell', 'command'],
  ['Grep', 'search'],
  ['Glob', 'search'],
  ['LS', 'search'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Read', 'read'],
  ['NotebookRead', 'read'],
]);

export function toolCategory(name) {
  return BY_NAME.get(String(name || '')) || 'other';
}

// What a tick carries about the tool, or null when there is no tool name.
// MCP tools (`mcp__server__tool`) are shown as "server · tool" and count as other.
export function tickTool(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const raw = name.trim().slice(0, 200);
  let pretty = raw;
  if (raw.startsWith('mcp__')) {
    const [, server = '', ...rest] = raw.split('__');
    pretty = `${server.replace(/^claude_ai_/, '')} · ${rest.join('__')}`;
  }
  return { name: pretty, category: toolCategory(raw) };
}
