/**
 * Convert a cwd path to a Claude Code project slug.
 * Claude Code uses this format for its project directories under ~/.claude/projects/
 *
 * Example: "/home/user/workspace/app" → "-home-user-workspace-app"
 */
export declare function cwdToSlug(cwd: string): string;
/**
 * Clean raw text from Claude Code JSONL for display.
 * Strips XML tags, internal markup, control sequences, and normalizes whitespace.
 */
export declare function cleanDisplayText(raw: string): string;
/**
 * Check if text is an internal/system message that shouldn't be shown as a task.
 */
export declare function isInternalMessage(text: string): boolean;
