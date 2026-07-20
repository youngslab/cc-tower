import fs from 'node:fs';
import path from 'node:path';

export interface ScannedSession {
  sessionId: string;
  cwd: string;
  startedAt: number; // epoch ms
  /** Session name set via Claude Code's `/rename` ({"type":"custom-title", ...}). */
  customTitle?: string;
}

// cwd appears within the first few lines of a Claude Code JSONL (after short
// metadata records), always within the first 16KB on measured history. We read
// a bounded head and parse complete lines only — never the whole (multi-MB) file.
const HEAD_BYTES = 16384;
// Fallback chunk size for locating a `/rename` that landed after the head, e.g. a
// late rename in a long-running conversation. Read from the tail in growing
// chunks rather than the whole (possibly multi-MB) file.
const TAIL_CHUNK_BYTES = 16384;
const MAX_TAIL_SCAN_BYTES = 1024 * 1024; // give up after 1MB from the end
// Yield to the event loop periodically so a large scan never stalls the single
// Node thread (e.g. delaying the first hook event / frame).
const YIELD_EVERY = 50;

/**
 * Scans `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` to enumerate every
 * resumable Claude Code session on disk. cwd is read from JSONL content (the
 * slug is lossy: '/', '.', '_' all map to '-'), and startedAt from the first
 * cwd-bearing line's timestamp (file mtime as fallback).
 *
 * Lazy + incremental: `ensureScanned()` does a full pass the first time, then
 * re-scans only directories whose mtime advanced. In-memory only.
 */
export class SessionScanner {
  private readonly projectsDir: string;
  private readonly cache = new Map<string, ScannedSession>(); // sessionId → scanned
  private readonly dirWatermark = new Map<string, number>();  // slug dir → mtimeMs at last scan
  private scanned = false;
  private inFlight: Promise<void> | null = null;

  constructor(projectsDir: string) {
    this.projectsDir = projectsDir;
  }

  /** True once at least one full scan has completed. */
  isScanned(): boolean {
    return this.scanned;
  }

  /** Current snapshot of scanned sessions (recency unsorted — caller sorts/merges). */
  getCached(): ScannedSession[] {
    return Array.from(this.cache.values());
  }

  /**
   * Idempotent: shares a single in-flight scan; resolves immediately when a
   * scan is already running or complete (the next call re-scans changed dirs).
   */
  ensureScanned(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async scan(): Promise<void> {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      this.scanned = true; // projects dir missing/unreadable → empty, no throw
      return;
    }

    let processed = 0;
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dirPath = path.join(this.projectsDir, dirent.name);

      let dirMtime: number;
      try { dirMtime = fs.statSync(dirPath).mtimeMs; } catch { continue; }
      if (this.dirWatermark.get(dirent.name) === dirMtime) continue; // unchanged — skip (incremental)

      let files: string[];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        const scanned = this.scanFile(path.join(dirPath, file), sessionId);
        if (scanned) {
          const existing = this.cache.get(sessionId);
          // Duplicate sessionId across dirs is anomalous (basename is unique);
          // if it happens, keep the most recent.
          if (!existing || scanned.startedAt > existing.startedAt) {
            this.cache.set(sessionId, scanned);
          }
        }
        if (++processed % YIELD_EVERY === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      this.dirWatermark.set(dirent.name, dirMtime);
    }
    this.scanned = true;
  }

  private scanFile(filePath: string, sessionId: string): ScannedSession | null {
    try {
      const st = fs.statSync(filePath);
      if (st.size === 0) return null;
      const readSize = Math.min(st.size, HEAD_BYTES);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, 'r');
      try { fs.readSync(fd, buf, 0, readSize, 0); } finally { fs.closeSync(fd); }

      const lines = buf.toString('utf8').split('\n');
      // If the file was truncated by the 16KB head read, the last element is a
      // partial line — discard it so JSON.parse never sees a half line. (When
      // the whole file fits, keep every line so a trailing complete line isn't lost.)
      const complete = st.size > readSize ? lines.slice(0, -1) : lines;

      // cwd and the `/rename` custom-title can land on different early lines, so
      // collect both rather than returning at the first cwd. A session can be
      // `/rename`d more than once, so keep overwriting on every match — the
      // last one in file order (chronological) is the current name — rather
      // than stopping at the first.
      let cwd: string | undefined;
      let startedAt = st.mtimeMs;
      let customTitle: string | undefined;
      for (const line of complete) {
        if (!line.trim()) continue;
        let obj: { cwd?: unknown; timestamp?: unknown; type?: unknown; customTitle?: unknown };
        try { obj = JSON.parse(line); } catch { continue; }
        if (cwd === undefined && typeof obj.cwd === 'string') {
          cwd = obj.cwd;
          const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
          if (Number.isFinite(ts)) startedAt = ts;
        }
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
          customTitle = obj.customTitle;
        }
      }
      if (cwd === undefined) return null;

      // A later `/rename` can land arbitrarily far past the head we already read
      // (up to and including past our 16KB window) — always check the tail (when
      // the file is bigger than the head) so a more recent rename there overrides
      // whatever we found in the head. Bounded, growing-chunk scan rather than
      // reading the whole multi-MB file.
      if (st.size > readSize) {
        const tailTitle = this.scanTailForCustomTitle(filePath, st.size, readSize);
        if (tailTitle !== undefined) customTitle = tailTitle;
      }

      return customTitle !== undefined
        ? { sessionId, cwd, startedAt, customTitle }
        : { sessionId, cwd, startedAt };
    } catch { /* unreadable/corrupt → skip */ }
    return null;
  }

  /** Reads growing chunks from the end of the file looking for a `type:"custom-title"` line. */
  private scanTailForCustomTitle(filePath: string, fileSize: number, headCovered: number): string | undefined {
    const scanLimit = Math.max(headCovered, fileSize - MAX_TAIL_SCAN_BYTES);
    let chunkSize = TAIL_CHUNK_BYTES;
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      for (;;) {
        const start = Math.max(scanLimit, fileSize - chunkSize);
        const size = fileSize - start;
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, start);

        // Drop a possibly-partial first line (we didn't start on a line boundary),
        // unless this chunk reaches all the way back to the already-scanned head.
        const lines = buf.toString('utf8').split('\n');
        const complete = start > scanLimit ? lines.slice(1) : lines;
        // Keep the LAST match in this chunk (chronologically most recent — the
        // chunk always extends to EOF, so nothing after it could be newer),
        // not the first, in case the session was `/rename`d more than once here.
        let found: string | undefined;
        for (const line of complete) {
          if (!line.trim()) continue;
          let obj: { type?: unknown; customTitle?: unknown };
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
            found = obj.customTitle;
          }
        }
        if (found !== undefined) return found;

        if (start <= scanLimit) return undefined;
        chunkSize *= 2;
      }
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
