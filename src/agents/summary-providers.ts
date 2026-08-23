import { normalizeAgentId, type AgentId } from './types.js';
import type { SummaryProvider } from './summary-provider.js';
import { claudeSummaryProvider } from './claude/summary-provider.js';
import { codexSummaryProvider } from './codex/summary-provider.js';

const providers: Record<AgentId, SummaryProvider> = {
  claude: claudeSummaryProvider,
  codex: codexSummaryProvider,
};

export function getSummaryProvider(agentId: AgentId | undefined): SummaryProvider {
  return providers[normalizeAgentId(agentId)];
}

export function listSummaryProviders(): SummaryProvider[] {
  return Object.values(providers);
}

export type { SummaryProvider, SummaryProviderInput } from './summary-provider.js';
