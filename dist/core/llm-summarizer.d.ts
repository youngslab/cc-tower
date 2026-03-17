export declare function startLlmSession(): Promise<void>;
export declare function stopLlmSession(): Promise<void>;
export declare function getLlmSessionName(): string;
/**
 * Generate a 1-line context summary using `claude --print`.
 * Fully async + non-blocking. Returns cached result if messages unchanged.
 */
export declare function generateContextSummary(sessionId: string, recentMessages: string): Promise<string | undefined>;
