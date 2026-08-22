import type { AgentId } from './types.js';
import { getAgentAdapter } from './registry.js';

export interface AgentCommandInput {
  agentId?: AgentId;
  cwd: string;
  resumeId?: string;
  claudeArgs?: string;
  claudeBin?: string;
}

export { shellQuote } from './shell.js';

export function buildAgentCommand(input: AgentCommandInput): string {
  return getAgentAdapter(input.agentId).buildCommand(input);
}

export function agentWindowName(agentId: AgentId | undefined, projectName: string): string {
  return getAgentAdapter(agentId).windowName(projectName);
}
