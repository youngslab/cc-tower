import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveCodexThreadMetadata } from '../../../src/agents/codex/metadata.js';

describe('codex metadata resolver', () => {
  it('uses threads.name as the user rename label for an exact resume UUID', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      resumeArg: 'uuid-1',
      threads: [{ id: 'uuid-1', cwd: '/repo', title: 'Build Codex support', name: 'diagnostic-name', updatedAt: 2 }],
    });

    expect(result).toMatchObject({
      threadId: 'uuid-1',
      label: 'diagnostic-name',
      labelSource: 'codex-rename',
      confidence: 'high',
      resumable: true,
    });
  });

  it('falls back to threads.title when no user rename is set for an exact resume UUID', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      resumeArg: 'uuid-1',
      threads: [{ id: 'uuid-1', cwd: '/repo', title: 'Build Codex support', updatedAt: 2 }],
    });

    expect(result).toMatchObject({
      threadId: 'uuid-1',
      label: 'Build Codex support',
      labelSource: 'codex-title',
      confidence: 'high',
      resumable: true,
    });
  });

  it('does not let a second live process claim an already claimed exact UUID', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      resumeArg: 'uuid-1',
      threads: [{ id: 'uuid-1', cwd: '/repo', title: 'Already claimed', updatedAt: 2 }],
      claimedThreadIds: new Set(['uuid-1']),
    });

    expect(result.threadId).toBeUndefined();
    expect(result.label).toBe('Already claimed');
    expect(result.confidence).toBe('medium');
    expect(result.resumable).toBe(false);
  });

  it('fails closed when a title match is duplicated across claimed and unclaimed rows', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      resumeArg: 'Same title',
      threads: [
        { id: 'claimed', cwd: '/repo', title: 'Same title', updatedAt: 1 },
        { id: 'unclaimed', cwd: '/repo', title: 'Same title', updatedAt: 2 },
      ],
      claimedThreadIds: new Set(['claimed']),
    });

    expect(result.threadId).toBeUndefined();
    expect(result.label).toBe('Same title');
    expect(result.confidence).toBe('medium');
    expect(result.resumable).toBe(false);
  });

  it('does not fall back to same-cwd claim when the only title match is already claimed', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      resumeArg: 'Taken title',
      threads: [
        { id: 'claimed', cwd: '/repo', title: 'Taken title', updatedAt: 2 },
        { id: 'other-unclaimed-same-cwd', cwd: '/repo', title: 'Other', updatedAt: 3 },
      ],
      claimedThreadIds: new Set(['claimed']),
    });

    expect(result.threadId).toBeUndefined();
    expect(result.label).toBe('Taken title');
    expect(result.confidence).toBe('medium');
    expect(result.resumable).toBe(false);
  });

  it('uses threads.name as the user rename label for an authoritative cwd match', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      threads: [{ id: 'uuid-1', cwd: '/repo', title: 'Auto title', name: 'user rename', updatedAt: 2 }],
    });

    expect(result.threadId).toBe('uuid-1');
    expect(result.label).toBe('user rename');
    expect(result.labelSource).toBe('codex-rename');
  });

  it('uses OMX session start time to pick the matching renamed thread among same-cwd rows', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      sessionStartedAt: 2000,
      threads: [
        { id: 'matching-thread', cwd: '/repo', title: 'Auto title', name: 'user rename', createdAt: 2001, updatedAt: 3 },
        { id: 'other-thread', cwd: '/repo', title: 'Newest unrelated', name: 'wrong rename', createdAt: 3000, updatedAt: 4 },
      ],
    });

    expect(result).toMatchObject({
      threadId: 'matching-thread',
      label: 'user rename',
      labelSource: 'codex-rename',
      confidence: 'high',
      resumable: true,
    });
  });

  it('fails closed on duplicate same-cwd sessions by withholding resumeId', () => {
    const result = resolveCodexThreadMetadata({
      cwd: '/repo',
      threads: [
        { id: 'uuid-new', cwd: '/repo', title: 'Newest', updatedAt: 3 },
        { id: 'uuid-old', cwd: '/repo', title: 'Oldest', updatedAt: 1 },
      ],
    });

    expect(result.threadId).toBeUndefined();
    expect(result.label).toBe('Newest');
    expect(result.confidence).toBe('medium');
    expect(result.resumable).toBe(false);
  });

  it('keeps the SQLite reader implementation read-only', () => {
    const source = readFileSync(new URL('../../../src/agents/codex/metadata.ts', import.meta.url), 'utf8');
    expect(source).toContain('mode=ro');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
  });
});
