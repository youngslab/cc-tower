export type AgentId = 'claude' | 'codex';
export type LabelSource = 'claude-custom-title' | 'codex-title' | 'codex-rename' | 'popmux';
export declare function normalizeAgentId(value: unknown): AgentId;
export declare function agentLabel(agentId: AgentId | undefined): string;
export declare function agentBadge(agentId: AgentId | undefined): string;
export declare function agentShortBadge(agentId: AgentId | undefined): string;
