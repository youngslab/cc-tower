export type AgentId = 'claude' | 'codex';

export type LabelSource =
  | 'claude-custom-title'
  | 'codex-title'
  | 'codex-rename'
  | 'popmux';

export function normalizeAgentId(value: unknown): AgentId {
  return value === 'codex' ? 'codex' : 'claude';
}

export function agentLabel(agentId: AgentId | undefined): string {
  return normalizeAgentId(agentId) === 'codex' ? 'Codex' : 'Claude';
}

export function agentBadge(agentId: AgentId | undefined): string {
  return normalizeAgentId(agentId) === 'codex' ? '[Codex]' : '[Claude]';
}

export function agentShortBadge(agentId: AgentId | undefined): string {
  return normalizeAgentId(agentId) === 'codex' ? 'X' : 'C';
}
