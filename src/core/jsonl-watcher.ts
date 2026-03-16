import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseJsonlLine, ParsedMessage } from '../utils/jsonl-parser.js';
import { cleanDisplayText, isInternalMessage } from '../utils/slug.js';

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

    // Walk backwards to find last state-determining message.
    // Priority order:
    // 1. system turn_duration/stop_hook_summary → idle (turn definitively ended)
    // 2. assistant end_turn → idle
    // 3. assistant tool_use → executing
    // 4. assistant stop_reason=null → thinking (streaming)
    // `user` messages alone are unreliable — internal commands create entries without turns.
    let sawUser = false;
    let sawTurnEnd = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseJsonlLine(lines[i]);
      if (!parsed) continue;

      // system turn_duration or stop_hook_summary = turn is over
      if (parsed.type === 'system' && (parsed.systemSubtype === 'turn_duration' || parsed.systemSubtype === 'stop_hook_summary')) {
        sawTurnEnd = true;
        continue;
      }

      if (parsed.type === 'assistant') {
        if (parsed.stopReason === 'end_turn') return 'idle';
        if (sawTurnEnd) return 'idle'; // turn ended even if stop_reason is None/tool_use
        if (parsed.stopReason === 'tool_use') return 'executing';
        if (parsed.stopReason === null) return 'thinking';
        continue;
      }

      if (parsed.type === 'user') {
        if (sawTurnEnd) return 'idle'; // turn ended after this user message
        sawUser = true;
        continue;
      }
    }

    // If we only found user messages with no assistant, likely thinking
    // But if no messages at all, idle
    return sawUser ? 'thinking' : 'idle';
  }

  /**
   * Extract the last user message content from a JSONL file (for cold start currentTask).
   */
  coldStartLastTask(jsonlPath: string): string | undefined {
    let content: string;
    try {
      content = fs.readFileSync(jsonlPath, 'utf8');
    } catch {
      return undefined;
    }

    const lines = content.split('\n').filter(l => l.trim());
    // Walk backwards to find last real user message (skip internal commands)
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseJsonlLine(lines[i]!);
      if (!parsed) continue;
      if (parsed.type === 'user' && parsed.userContent) {
        const text = parsed.userContent.trim();
        if (isInternalMessage(text)) continue;
        return cleanDisplayText(text).slice(0, 80);
      }
    }
    return undefined;
  }

  /**
   * Start watching a JSONL file for new lines. Starts reading from the end
   * of the file so we only emit new events, not historical ones.
   */
  watch(sessionId: string, jsonlPath: string): void {
    if (this.watchers.has(sessionId)) {
      this.unwatch(sessionId);
    }

    // Skip if file doesn't exist
    if (!fs.existsSync(jsonlPath)) return;

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

  /**
   * Async background summary: read last N bytes of JSONL and extract latest activity.
   * Non-blocking — designed to be called on an interval without blocking UI.
   */
  async readLatestActivity(jsonlPath: string): Promise<string | undefined> {
    try {
      const stat = fs.statSync(jsonlPath);
      const readSize = Math.min(stat.size, 262144); // last 256KB
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(jsonlPath, 'r');
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n').filter(l => l.trim());

      // Walk backwards for latest meaningful message
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (!parsed) continue;

        if (parsed.type === 'assistant') {
          if (parsed.stopReason === 'tool_use' && parsed.toolName) {
            const desc = parsed.toolInput
              ? `${parsed.toolName}: ${parsed.toolInput}`
              : parsed.toolName;
            return desc;
          }
          if (parsed.stopReason === 'end_turn' && parsed.assistantText) {
            const text = cleanDisplayText(parsed.assistantText);
            return `✓ ${text.split('.')[0]?.slice(0, 60) ?? 'Done'}`;
          }
          if (parsed.stopReason === null && parsed.assistantText) {
            return cleanDisplayText(parsed.assistantText).slice(0, 60);
          }
        }

        if (parsed.type === 'user' && parsed.userContent) {
          const raw = parsed.userContent.trim();
          if (isInternalMessage(raw)) continue;
          return cleanDisplayText(raw).slice(0, 60);
        }
      }
    } catch {
      // File missing or unreadable — skip silently
    }
    return undefined;
  }

  /**
   * Read recent user messages from JSONL for LLM context summary.
   * Returns concatenated user messages (last N), cleaned.
   */
  /**
   * Read recent conversation context (user + assistant messages) for LLM summarization.
   * Returns a formatted string with role labels for richer context.
   */
  async readRecentContext(jsonlPath: string, maxMessages: number = 15): Promise<string | undefined> {
    try {
      const stat = fs.statSync(jsonlPath);
      const readSize = Math.min(stat.size, 524288); // last 512KB
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(jsonlPath, 'r');
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n').filter(l => l.trim());

      const messages: string[] = [];
      for (let i = lines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (!parsed) continue;

        if (parsed.type === 'user' && parsed.userContent) {
          const text = parsed.userContent.trim();
          if (isInternalMessage(text)) continue;
          const cleaned = cleanDisplayText(text);
          if (cleaned.length <= 5) continue;
          messages.unshift(`USER: ${cleaned.slice(0, 200)}`);
        } else if (parsed.type === 'assistant') {
          if (parsed.stopReason === 'tool_use' && parsed.toolName) {
            const tool = parsed.toolInput
              ? `${parsed.toolName}: ${parsed.toolInput}`
              : parsed.toolName;
            messages.unshift(`TOOL: ${tool}`);
          } else if (parsed.stopReason === 'end_turn' && parsed.assistantText) {
            const text = cleanDisplayText(parsed.assistantText);
            if (text.length > 5) {
              messages.unshift(`CLAUDE: ${text.slice(0, 200)}`);
            }
          }
        }
      }

      return messages.length > 0 ? messages.join('\n') : undefined;
    } catch {
      return undefined;
    }
  }

  unwatchAll(): void {
    for (const [sessionId] of this.watchers) {
      this.unwatch(sessionId);
    }
  }
}
