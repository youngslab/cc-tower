import type { AgentId } from './types.js';
import type { AgentCommandInput as AdapterAgentCommandInput } from './adapter.js';
export type AgentCommandInput = AdapterAgentCommandInput & {
    agentId?: AgentId;
};
export { shellQuote } from './shell.js';
export declare function buildAgentCommand(input: AgentCommandInput): string;
export declare function agentWindowName(agentId: AgentId | undefined, projectName: string): string;
