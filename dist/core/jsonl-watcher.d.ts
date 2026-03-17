import { EventEmitter } from 'node:events';
type SessionState = 'idle' | 'thinking' | 'executing';
export declare class JsonlWatcher extends EventEmitter {
    private watchers;
    /**
     * Scan a JSONL file to determine the current session state at cold start.
     * Reads the last meaningful message to infer state.
     */
    coldStartScan(jsonlPath: string): SessionState;
    /**
     * Extract the last user message content from a JSONL file (for cold start currentTask).
     */
    coldStartLastTask(jsonlPath: string): string | undefined;
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
    unwatchAll(): void;
}
export {};
