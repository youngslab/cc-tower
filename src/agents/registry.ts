/**
 * Agent registry — single import surface for all per-agent modules.
 *
 * The adapter layer keeps platform-specific behavior (discovery, commands,
 * pane-title status, capabilities) behind a common boundary. Legacy namespace
 * exports (`agents.claude.*`) stay available while Tower/UI migrate to the
 * adapter methods.
 */
import { ClaudeAgent } from './claude/index.js';
import { claudeAdapter } from './claude/adapter.js';
import { CodexAgent } from './codex/index.js';
import { codexAdapter } from './codex/adapter.js';
import { normalizeAgentId, type AgentId, type LabelSource } from './types.js';
import type { AgentAdapter } from './adapter.js';
export type { AgentId, LabelSource } from './types.js';
export type { AgentAdapter, AgentCommandInput, AgentDiscoveryContext, AgentStatus } from './adapter.js';

const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export const agents = {
  claude: ClaudeAgent,
  codex: CodexAgent,
  adapters,
} as const;

export function getAgentAdapter(agentId: AgentId | undefined): AgentAdapter {
  return adapters[normalizeAgentId(agentId)];
}

export function listAgentAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
