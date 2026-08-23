import { type AgentId } from './types.js';
import type { SummaryProvider } from './summary-provider.js';
export declare function getSummaryProvider(agentId: AgentId | undefined): SummaryProvider;
export declare function listSummaryProviders(): SummaryProvider[];
export type { SummaryProvider, SummaryProviderInput } from './summary-provider.js';
