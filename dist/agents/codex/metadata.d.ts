import type { CodexThreadRow } from './types.js';
export declare function findCodexStateDb(codexHome?: string): string | undefined;
/**
 * Read Codex thread metadata through Python's stdlib sqlite3 in read-only URI mode.
 * This module intentionally never writes to Codex SQLite; failures return [] so the
 * popup can fall back to process-derived labels without blocking.
 */
export declare function readCodexThreads(opts?: {
    codexHome?: string;
    dbPath?: string;
    limit?: number;
}): CodexThreadRow[];
export declare function readCodexThreadById(threadId: string, opts?: {
    codexHome?: string;
    dbPath?: string;
}): CodexThreadRow | undefined;
export declare function resolveCodexThreadMetadata(input: {
    cwd: string;
    resumeArg?: string | undefined;
    resumeWithoutArg?: boolean | undefined;
    sessionStartedAt?: number | undefined;
    threads: CodexThreadRow[];
    claimedThreadIds?: Set<string>;
}): {
    threadId?: string;
    label?: string;
    labelSource?: 'codex-title' | 'codex-rename';
    confidence: 'low' | 'medium' | 'high';
    resumable: boolean;
};
