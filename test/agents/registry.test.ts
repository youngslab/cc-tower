import { describe, expect, it } from 'vitest';
import { getAgentAdapter, listAgentAdapters } from '../../src/agents/registry.js';

describe('agent adapter registry', () => {
  it('exposes Claude and Codex through the same adapter contract', () => {
    const ids = listAgentAdapters().map(a => a.id).sort();
    expect(ids).toEqual(['claude', 'codex']);
    expect(getAgentAdapter('claude').capabilities).toMatchObject({ hooks: true, remote: false, jsonl: true, sqlite: false });
    expect(getAgentAdapter('codex').capabilities).toMatchObject({ hooks: false, remote: false, summaries: true, jsonl: false, sqlite: true });
  });

  it('keeps command construction behind the adapter boundary', () => {
    expect(getAgentAdapter('claude').buildCommand({ cwd: '/repo', resumeId: 'abc', claudeArgs: '--x' }))
      .toBe("claude --resume 'abc' --x");
    expect(getAgentAdapter('codex').buildCommand({ cwd: '/repo', resumeId: '019f' }))
      .toBe("codex resume '019f' -C '/repo'");
  });

  it('keeps default resume policy behind the adapter boundary', () => {
    const claude = getAgentAdapter('claude');
    const codex = getAgentAdapter('codex');

    expect(claude.defaultResumeId?.({ pid: 1, sessionId: 'claude-sid', cwd: '/repo', startedAt: 1 })).toBe('claude-sid');
    expect(claude.defaultResumable?.({ pid: 1, sessionId: 'claude-sid', cwd: '/repo', startedAt: 1 })).toBe(true);

    expect(codex.defaultResumeId?.({ pid: 2, sessionId: 'codex-sid', resumeId: 'codex-resume', cwd: '/repo', startedAt: 1 })).toBe('codex-resume');
    expect(codex.defaultResumable?.({ pid: 2, sessionId: 'codex-sid', resumeId: 'codex-resume', cwd: '/repo', startedAt: 1 })).toBe(true);
    expect(codex.defaultResumable?.({ pid: 3, sessionId: 'codex-proc-123', cwd: '/repo', startedAt: 1 })).toBe(false);
  });

  it('keeps pane-title status inference behind the adapter boundary', () => {
    expect(getAgentAdapter('claude').inferPaneBusy('◐ repo')).toBe(true);
    expect(getAgentAdapter('claude').inferPaneBusy('repo')).toBeUndefined();
    expect(getAgentAdapter('codex').inferPaneBusy('⠦ repo')).toBe(true);
    expect(getAgentAdapter('codex').inferPaneBusy('repo')).toBe(false);
  });

  it('keeps Claude artifact path construction behind the adapter boundary', () => {
    expect(getAgentAdapter('claude').sessionArtifactPath?.({ rootDir: '/x/.claude', cwd: '/repo/app', sessionId: 'sid' }))
      .toBe('/x/.claude/projects/-repo-app/sid.jsonl');
    expect(getAgentAdapter('codex').sessionArtifactPath).toBeUndefined();
  });

  it('exposes Claude lifecycle hooks through the adapter', () => {
    const claude = getAgentAdapter('claude');
    expect(claude.parseSessionFile).toBeTypeOf('function');
    expect(claude.isHeadlessSession).toBeTypeOf('function');
    expect(claude.coldStartStatus).toBeTypeOf('function');
    expect(claude.readLastTask).toBeTypeOf('function');
    expect(claude.extractLabel).toBeTypeOf('function');
    expect(claude.generateAllSummaries).toBeTypeOf('function');
  });

  it('keeps unsupported Codex JSONL lifecycle hooks absent while summaries use providers', () => {
    const codex = getAgentAdapter('codex');
    expect(codex.parseSessionFile).toBeUndefined();
    expect(codex.coldStartStatus).toBeUndefined();
    expect(codex.generateAllSummaries).toBeUndefined();
    expect(codex.capabilities.summaries).toBe(true);
    expect(codex.discoverLiveSessions).toBeTypeOf('function');
  });

});
