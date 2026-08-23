import type { AgentId } from './types.js';
import type { AgentSummaries } from './adapter.js';
export interface SummaryProviderInput {
    sessionId: string;
    cwd: string;
    artifactPath?: string | undefined;
    readEarlyContext?: ((artifactPath: string, maxMessages?: number) => Promise<string | undefined>) | undefined;
    readRecentContext?: ((artifactPath: string, maxMessages?: number) => Promise<string | undefined>) | undefined;
}
export interface SummaryProvider {
    agentId: AgentId;
    start?(): Promise<void> | void;
    stop?(): Promise<void> | void;
    clearCache?(sessionId: string): void;
    generate(input: SummaryProviderInput): Promise<AgentSummaries | undefined> | AgentSummaries | undefined;
}
