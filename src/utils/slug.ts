/**
 * Convert a cwd path to a Claude Code project slug.
 * Claude Code uses this format for its project directories under ~/.claude/projects/
 *
 * Example: "/home/user/workspace/app" → "-home-user-workspace-app"
 */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
