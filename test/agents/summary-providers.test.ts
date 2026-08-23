import { describe, expect, it } from 'vitest';
import { getSummaryProvider, listSummaryProviders } from '../../src/agents/summary-providers.js';

describe('summary provider registry', () => {
  it('routes summary generation by agent id', () => {
    expect(listSummaryProviders().map(provider => provider.agentId).sort()).toEqual(['claude', 'codex']);
    expect(getSummaryProvider('claude').agentId).toBe('claude');
    expect(getSummaryProvider('codex').agentId).toBe('codex');
  });
});
