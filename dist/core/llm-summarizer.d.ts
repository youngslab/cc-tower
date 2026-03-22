/** Clear all cached summaries for a session so next call regenerates. */
export declare function clearSummaryCache(sessionId: string): void;
export declare function startLlmSession(): Promise<void>;
export declare function stopLlmSession(): Promise<void>;
export declare function getLlmSessionName(): string;
/**
 * Generate a 1-line context summary using `claude --print`.
 * Fully async + non-blocking. Returns cached result if messages unchanged.
 */
export declare function generateContextSummary(sessionId: string, recentMessages: string): Promise<string | undefined>;
/**
 * Generate a 1-line goal summary using `claude --print`.
 * Generated once from early messages. Returns cached result if messages unchanged.
 */
export declare function generateGoalSummary(sessionId: string, earlyMessages: string): Promise<string | undefined>;
/**
 * Generate a next-steps suggestion using `claude --print`.
 * Called on idle transition. Returns undefined if no clear next step.
 */
export declare function generateNextSteps(sessionId: string, recentMessages: string): Promise<string | undefined>;
