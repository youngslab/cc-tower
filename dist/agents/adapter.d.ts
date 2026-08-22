import type { AgentId, LabelSource } from './types.js';
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
export interface AgentCommandInput {
    cwd: string;
    resumeId?: string;
    claudeArgs?: string;
    claudeBin?: string;
}
export interface AgentSessionInfo {
    agentId?: AgentId;
    pid: number;
    sessionId: string;
    resumeId?: string;
    resumable?: boolean;
    label?: string;
    labelSource?: LabelSource;
    paneId?: string;
    cwd: string;
    startedAt: number;
    host?: string;
    sshTarget?: string;
}
export interface AgentDiscoveryContext {
    claudeDir?: string;
    usedSessionIdsByCwd?: (cwd: string, pid: number) => Set<string>;
}
export interface AgentCapabilities {
    hooks: boolean;
    resume: boolean;
    remote: boolean;
    summaries: boolean;
    jsonl: boolean;
    sqlite: boolean;
}
export interface AgentSummaries {
    goal?: string;
    context?: string;
    nextSteps?: string;
}
export interface AgentAdapter {
    id: AgentId;
    label: string;
    shortBadge: string;
    capabilities: AgentCapabilities;
    buildCommand(input: AgentCommandInput): string;
    windowName(projectName: string): string;
    inferPaneBusy(title: string): boolean | undefined;
    discoverLiveSessions?(context?: AgentDiscoveryContext): Promise<AgentSessionInfo[]> | AgentSessionInfo[];
    parseSessionFile?(filePath: string): Promise<AgentSessionInfo | null> | AgentSessionInfo | null;
    isHeadlessSession?(sessionsDir: string, pid: number): boolean;
    coldStartStatus?(sessionArtifactPath: string): AgentStatus;
    readLastTask?(sessionArtifactPath: string): string | undefined;
    extractLabel?(sessionArtifactPath: string): string | undefined;
    clearSummaryCache?(sessionId: string): void;
    startLlmSession?(): Promise<void> | void;
    stopLlmSession?(): Promise<void> | void;
    generateAllSummaries?(sessionId: string, earlyMessages: string, recentMessages: string): Promise<AgentSummaries | undefined>;
    generateGoalSummary?(sessionId: string, earlyMessages: string): Promise<string | undefined>;
    generateContextSummary?(sessionId: string, recentMessages: string): Promise<string | undefined>;
    generateNextSteps?(sessionId: string, recentMessages: string): Promise<string | undefined>;
}
