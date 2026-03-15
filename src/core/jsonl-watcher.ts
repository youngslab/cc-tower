import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { parseJsonlLine, ParsedMessage } from '../utils/jsonl-parser.js';

type SessionState = 'idle' | 'thinking' | 'executing';

interface WatchEntry {
  fsWatcher: fs.FSWatcher;
  offset: number;
  reconcileTimer: ReturnType<typeof setInterval>;
  jsonlPath: string;
}

export class JsonlWatcher extends EventEmitter {
  private watchers: Map<string, WatchEntry> = new Map();

  /**
   * Scan a JSONL file to determine the current session state at cold start.
   * Reads the last meaningful message to infer state.
   */
  coldStartScan(jsonlPath: string): SessionState {
    let content: string;
    try {
      content = fs.readFileSync(jsonlPath, 'utf8');
    } catch {
      return 'idle';
    }

    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return 'idle';

    // Walk backwards to find last state-determining message
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseJsonlLine(lines[i]);
      if (!parsed) continue;

      if (parsed.type === 'assistant') {
        if (parsed.stopReason === 'end_turn') return 'idle';
        if (parsed.stopReason === 'tool_use') return 'executing';
        // assistant with no stop_reason (streaming) → thinking
        return 'thinking';
      }

      if (parsed.type === 'user') {
        return 'thinking';
      }
    }

    return 'idle';
  }

  /**
   * Start watching a JSONL file for new lines. Starts reading from the end
   * of the file so we only emit new events, not historical ones.
   */
  watch(sessionId: string, jsonlPath: string): void {
    if (this.watchers.has(sessionId)) {
      this.unwatch(sessionId);
    }

    // Start offset at end of current file
    let offset = 0;
    try {
      const stat = fs.statSync(jsonlPath);
      offset = stat.size;
    } catch {
      offset = 0;
    }

    const fsWatcher = fs.watch(jsonlPath, () => {
      // Guard: may have been unwatched between event fire and handler
      if (!this.watchers.has(sessionId)) return;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        return;
      }

      const newSize = stat.size;
      if (newSize <= offset) return; // file truncated or no new data

      const entry = this.watchers.get(sessionId);
      if (!entry) return;

      // Read only new bytes
      const fd = fs.openSync(jsonlPath, 'r');
      const length = newSize - entry.offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, entry.offset);
      fs.closeSync(fd);

      entry.offset = newSize;

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n');
      // Last element may be incomplete (no trailing newline) — skip it
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const parsed = parseJsonlLine(line);
        if (parsed) {
          this.emit('jsonl-event', { sessionId, parsed });
        }
      }
    });

    const reconcileInterval = 30000;
    const reconcileTimer = setInterval(() => {
      if (!this.watchers.has(sessionId)) return;
      const entry = this.watchers.get(sessionId);
      if (!entry) return;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        return;
      }

      const newSize = stat.size;
      if (newSize <= entry.offset) return;

      const fd = fs.openSync(jsonlPath, 'r');
      const length = newSize - entry.offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, entry.offset);
      fs.closeSync(fd);

      entry.offset = newSize;

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const parsed = parseJsonlLine(line);
        if (parsed) {
          this.emit('jsonl-event', { sessionId, parsed });
        }
      }
    }, reconcileInterval);

    this.watchers.set(sessionId, { fsWatcher, offset, reconcileTimer, jsonlPath });
  }

  unwatch(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (entry) {
      entry.fsWatcher.close();
      clearInterval(entry.reconcileTimer);
      this.watchers.delete(sessionId);
    }
  }

  unwatchAll(): void {
    for (const [sessionId] of this.watchers) {
      this.unwatch(sessionId);
    }
  }
}
