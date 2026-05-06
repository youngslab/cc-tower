export type SessionState = 'idle' | 'thinking' | 'executing';
/**
 * Scan a Claude Code JSONL file to determine the current session state at cold start.
 * Reads the last meaningful message to infer state.
 */
export declare function coldStartScan(jsonlPath: string): SessionState;
/**
 * Extract the last user message content from a JSONL file (for cold start currentTask).
 */
export declare function coldStartLastTask(jsonlPath: string): string | undefined;
/**
 * Extract the latest custom-title (/rename) from a JSONL file.
 */
export declare function coldStartCustomTitle(jsonlPath: string): string | undefined;
