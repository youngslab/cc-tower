/**
 * SessionSearch — Tier 1 (in-process, ink-testing-library)
 *
 * Covers: named-only filtering (incl. sessions without a paneId), fuzzy
 * subsequence filtering by label, Enter→onSelect, Esc→onCancel, and the
 * pure fuzzyMatch helper.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SessionSearch } from '../../src/ui/SessionSearch.js';
import { fuzzyMatch } from '../../src/ui/fuzzy.js';
import type { Session } from '../../src/core/session-store.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1000,
    paneId: '%1',
    sessionId: 'sid',
    hasTmux: true,
    detectionMode: 'jsonl',
    cwd: '/home/test/project',
    projectName: 'project',
    status: 'idle',
    lastActivity: new Date(),
    startedAt: new Date(),
    messageCount: 0,
    toolCallCount: 0,
    host: 'local',
    sshTarget: undefined,
    ...overrides,
  } as Session;
}

const settle = (ms = 80) => new Promise<void>(r => setTimeout(r, ms));

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('twr', 'cc-tower')).toBe(true);
    expect(fuzzyMatch('AL', 'alpha')).toBe(true);
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });
  it('rejects non-subsequences', () => {
    expect(fuzzyMatch('al', 'beta')).toBe(false);
    expect(fuzzyMatch('xyz', 'alpha')).toBe(false);
  });
});

describe('SessionSearch (ink-testing-library)', () => {
  const sessions = [
    makeSession({ label: 'alpha', paneId: '%1', sessionId: 's-alpha', projectName: 'projA' }),
    makeSession({ label: 'beta', paneId: undefined, sessionId: 's-beta', projectName: 'projB' }),
    makeSession({ label: undefined, paneId: '%3', sessionId: 's-gamma', projectName: 'projGamma' }),
  ];

  it('lists only named sessions, including those without a paneId', async () => {
    const { lastFrame, unmount } = render(
      <SessionSearch sessions={sessions} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');        // named, no paneId — still shown
    expect(frame).not.toContain('projGamma'); // unnamed — excluded
    unmount();
  });

  it('filters by label as the user types', async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionSearch sessions={sessions} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('al');
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alpha');
    expect(frame).not.toContain('beta');
    unmount();
  });

  it('Enter selects the highlighted result', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionSearch sessions={sessions} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('\r');
    await settle();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].sessionId).toBe('s-alpha');
    unmount();
  });

  it('arrow-down then Enter selects the second result', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionSearch sessions={sessions} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('\x1b[B'); // down arrow
    await settle();
    stdin.write('\r');
    await settle();
    expect(onSelect.mock.calls[0][0].sessionId).toBe('s-beta');
    unmount();
  });

  it('Esc cancels', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <SessionSearch sessions={sessions} onSelect={vi.fn()} onCancel={onCancel} />,
    );
    await settle();
    stdin.write('\x1b');
    await settle();
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shows an empty state when no sessions are named', async () => {
    const { lastFrame, unmount } = render(
      <SessionSearch sessions={[makeSession({ label: undefined })]} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(lastFrame()!).toContain('No named sessions');
    unmount();
  });
});
