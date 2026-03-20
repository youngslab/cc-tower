import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface RecentProject {
  name: string;      // folder name (last segment of path)
  path: string;      // original absolute path
  lastUsed: Date;    // most recent JSONL mtime
}

/**
 * Convert a Claude project slug back to the original filesystem path.
 * Slug format: "-home-user-workspace-foo" → "/home/user/workspace/foo"
 *
 * Note: the slug replaces '/', '.', and '_' all with '-', so this reversal
 * is a best-effort using the leading '-' as the path separator marker.
 */
function slugToPath(slug: string): string {
  // The slug starts with '-' representing the leading '/'
  // Replace leading '-' with '/' then replace remaining '-' with '/'
  return '/' + slug.replace(/^-/, '').replace(/-/g, '/');
}

/**
 * Scan ~/.claude/projects/ to find recent project directories.
 * Returns up to `limit` projects sorted by most recently used.
 */
export function getRecentProjects(limit: number = 15): RecentProject[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir).filter(d => {
      try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }

  const projects: RecentProject[] = [];

  for (const slug of dirs) {
    const dirPath = path.join(projectsDir, slug);
    const originalPath = slugToPath(slug);

    // Check if path actually exists
    if (!fs.existsSync(originalPath)) continue;

    // Find most recent JSONL
    let latestMtime = 0;
    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dirPath, f));
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch {}
      }
    } catch {}

    if (latestMtime === 0) continue;

    projects.push({
      name: path.basename(originalPath),
      path: originalPath,
      lastUsed: new Date(latestMtime),
    });
  }

  // Sort by most recently used, take top N
  projects.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
  return projects.slice(0, limit);
}
