export interface ScannedSession {
    sessionId: string;
    cwd: string;
    startedAt: number;
    /** Session name set via Claude Code's `/rename` ({"type":"custom-title", ...}). */
    customTitle?: string;
}
/**
 * Scans `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` to enumerate every
 * resumable Claude Code session on disk. cwd is read from JSONL content (the
 * slug is lossy: '/', '.', '_' all map to '-'), and startedAt from the first
 * cwd-bearing line's timestamp (file mtime as fallback).
 *
 * Lazy + incremental: `ensureScanned()` does a full pass the first time, then
 * re-scans only directories whose mtime advanced. In-memory only.
 */
export declare class SessionScanner {
    private readonly projectsDir;
    private readonly cache;
    private readonly dirWatermark;
    private scanned;
    private inFlight;
    constructor(projectsDir: string);
    /** True once at least one full scan has completed. */
    isScanned(): boolean;
    /** Current snapshot of scanned sessions (recency unsorted — caller sorts/merges). */
    getCached(): ScannedSession[];
    /**
     * Idempotent: shares a single in-flight scan; resolves immediately when a
     * scan is already running or complete (the next call re-scans changed dirs).
     */
    ensureScanned(): Promise<void>;
    private scan;
    private scanFile;
    /** Reads growing chunks from the end of the file looking for a `type:"custom-title"` line. */
    private scanTailForCustomTitle;
}
