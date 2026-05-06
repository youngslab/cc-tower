import { EventEmitter } from 'node:events';
/**
 * Generic JSONL tail watcher.
 *
 * Observes append-only JSONL files (Claude Code's transcript format today)
 * and emits `jsonl-event` for each newly written line. Cold-start scanning
 * and any agent-specific interpretation of those lines lives in the
 * per-agent modules under `src/agents/<agent>/`, not here.
 */
export declare class JsonlWatcher extends EventEmitter {
    private watchers;
    /** Sessions waiting for their JSONL file to be created */
    private pendingWatchers;
    /**
     * Start watching a JSONL file for new lines. Starts reading from the end
     * of the file so we only emit new events, not historical ones.
     */
    watch(sessionId: string, jsonlPath: string): void;
    unwatch(sessionId: string): void;
    /**
     * Async background summary: read last N bytes of JSONL and extract latest activity.
     * Non-blocking — designed to be called on an interval without blocking UI.
     */
    readLatestActivity(jsonlPath: string): Promise<string | undefined>;
    /**
     * Read recent user messages from JSONL for LLM context summary.
     * Returns concatenated user messages (last N), cleaned.
     */
    /**
     * Read recent conversation context (user + assistant messages) for LLM summarization.
     * Returns a formatted string with role labels for richer context.
     */
    readRecentContext(jsonlPath: string, maxMessages?: number): Promise<string | undefined>;
    /**
     * Read early conversation context (first N messages) from JSONL for goal summarization.
     * Reads from the beginning of the file (first 512KB).
     */
    readEarlyContext(jsonlPath: string, maxMessages?: number): Promise<string | undefined>;
    unwatchAll(): void;
}
