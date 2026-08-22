import type { AgentId } from './types.js';
import type { AgentCommandInput as AdapterAgentCommandInput } from './adapter.js';
import { getAgentAdapter } from './registry.js';

export type AgentCommandInput = AdapterAgentCommandInput & { agentId?: AgentId };

export { shellQuote } from './shell.js';

export function buildAgentCommand(input: AgentCommandInput): string {
  return getAgentAdapter(input.agentId).buildCommand(input);
}

export function agentWindowName(agentId: AgentId | undefined, projectName: string): string {
  return getAgentAdapter(agentId).windowName(projectName);
}
