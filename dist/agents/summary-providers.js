import { normalizeAgentId } from './types.js';
import { claudeSummaryProvider } from './claude/summary-provider.js';
import { codexSummaryProvider } from './codex/summary-provider.js';
const providers = {
    claude: claudeSummaryProvider,
    codex: codexSummaryProvider,
};
export function getSummaryProvider(agentId) {
    return providers[normalizeAgentId(agentId)];
}
export function listSummaryProviders() {
    return Object.values(providers);
}
//# sourceMappingURL=summary-providers.js.map