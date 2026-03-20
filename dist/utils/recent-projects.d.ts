export interface RecentProject {
    name: string;
    path: string;
    lastUsed: Date;
}
/**
 * Scan ~/.claude/projects/ to find recent project directories.
 * Returns up to `limit` projects sorted by most recently used.
 */
export declare function getRecentProjects(limit?: number): RecentProject[];
