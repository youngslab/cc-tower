import type { SummaryProvider } from '../summary-provider.js';
import { ClaudeAgent } from './index.js';

export const claudeSummaryProvider: SummaryProvider = {
  agentId: 'claude',
  start() {
    return ClaudeAgent.startLlmSession();
  },
  stop() {
    return ClaudeAgent.stopLlmSession();
  },
  clearCache(sessionId: string) {
    ClaudeAgent.clearSummaryCache(sessionId);
  },
  async generate(input) {
    if (!input.artifactPath || !input.readEarlyContext || !input.readRecentContext) return undefined;

    const [earlyMessages, recentMessages] = await Promise.all([
      input.readEarlyContext(input.artifactPath, 15),
      input.readRecentContext(input.artifactPath, 15),
    ]);

    if (!recentMessages || recentMessages.length < 20) return undefined;
    return ClaudeAgent.generateAllSummaries(input.sessionId, earlyMessages ?? recentMessages, recentMessages);
  },
};
