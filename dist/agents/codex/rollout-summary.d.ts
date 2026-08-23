import type { AgentSummaries } from '../adapter.js';
import type { CodexThreadRow } from './types.js';
export declare function readCodexRolloutContext(rolloutPath: string, maxBytes?: number): string | undefined;
export declare function summarizeCodexThread(row: CodexThreadRow): AgentSummaries | undefined;
