import { type AgentId } from './types.js';
export declare function inferClaudePaneBusy(title: string): boolean | undefined;
export declare function inferCodexPaneBusy(title: string): boolean | undefined;
export declare function inferPaneBusyForAgent(title: string, agentId: AgentId | undefined): boolean | undefined;
