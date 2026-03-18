/**
 * Convert a cwd path to a Claude Code project slug.
 * Claude Code uses this format for its project directories under ~/.claude/projects/
 *
 * Example: "/home/user/workspace/app" → "-home-user-workspace-app"
 */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

/**
 * Clean raw text from Claude Code JSONL for display.
 * Strips XML tags, internal markup, control sequences, and normalizes whitespace.
 */
export function cleanDisplayText(raw: string): string {
  let text = raw;
  // Remove XML tags (task-notification, command-name, system-reminder, etc.)
  text = text.replace(/<[^>]+>/g, '');
  // Remove ANSI escape sequences
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  // Remove markdown formatting (bold, italic, headers, links)
  text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  text = text.replace(/#{1,6}\s*/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Collapse whitespace / newlines into single space
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Check if text is an internal/system message that shouldn't be shown as a task.
 */
export function isInternalMessage(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.startsWith('<command-name>')) return true;
  if (t.startsWith('<local-command')) return true;
  if (t.startsWith('<task-notification>')) return true;
  if (t.startsWith('<system-reminder>')) return true;
  if (t.startsWith('/') && t.length < 20) return true;
  return false;
}
