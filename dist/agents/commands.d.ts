import type { AgentId } from './types.js';
export interface AgentCommandInput {
    agentId?: AgentId;
    cwd: string;
    resumeId?: string;
    claudeArgs?: string;
    claudeBin?: string;
}
export { shellQuote } from './shell.js';
export declare function buildAgentCommand(input: AgentCommandInput): string;
export declare function agentWindowName(agentId: AgentId | undefined, projectName: string): string;
