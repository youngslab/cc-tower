import { readCodexThreadById } from './metadata.js';
import { summarizeCodexThread } from './rollout-summary.js';
export const codexSummaryProvider = {
    agentId: 'codex',
    generate(input) {
        if (input.sessionId.startsWith('codex-proc-'))
            return undefined;
        const thread = readCodexThreadById(input.sessionId);
        return thread ? summarizeCodexThread(thread) : undefined;
    },
};
//# sourceMappingURL=summary-provider.js.map