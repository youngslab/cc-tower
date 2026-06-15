/**
 * LLM-based context summarizer using a single combined `claude --print` call.
 *
 * Architecture:
 * - generateAllSummaries() issues ONE claude --print call for goal+context+nextSteps
 * - Fully async (spawn, not execSync) — does NOT block the event loop / UI
 * - No shared state, no context contamination between sessions
 * - Cache by sha256 content hash + persist in session store for instant cold start
 */
export interface AllSummaries {
    goal?: string;
    context?: string;
    nextSteps?: string;
}
/** Clear all cached summaries for a session so next call regenerates. */
export declare function clearSummaryCache(sessionId: string): void;
export declare function startLlmSession(): Promise<void>;
export declare function stopLlmSession(): Promise<void>;
export declare function getLlmSessionName(): string;
/**
 * Generate goal + context + nextSteps in ONE `claude --print` call.
 * earlyMessages = first N turns (for goal detection)
 * recentMessages = last N turns (for context + nextSteps)
 * Returns cached result if content hash unchanged.
 */
export declare function generateAllSummaries(sessionId: string, earlyMessages: string, recentMessages: string): Promise<AllSummaries | undefined>;
export declare function generateContextSummary(sessionId: string, recentMessages: string): Promise<string | undefined>;
export declare function generateGoalSummary(sessionId: string, earlyMessages: string): Promise<string | undefined>;
export declare function generateNextSteps(sessionId: string, recentMessages: string): Promise<string | undefined>;
