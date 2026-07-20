/**
 * ResumeSearch — Tier 1 (in-process, ink-testing-library)
 *
 * Covers: lists all past sessions (incl. unlabeled), fuzzy by label and by cwd
 * basename, empty state, Enter→onSelect, Esc→onCancel, empty-list Enter no-op,
 * and the (remote) tag rendering.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ResumeSearch } from '../../src/ui/ResumeSearch.js';
import type { PastSessionByCwd } from '../../src/ui/NewSession.js';

const past: PastSessionByCwd[] = [
  { sessionId: 's-alpha', cwd: '/home/me/projA', startedAt: 1, label: 'alpha' },
  { sessionId: 's-bare', cwd: '/home/me/zebra', startedAt: 2 }, // no label
  { sessionId: 's-remote', cwd: '/home/me/projR', startedAt: 3, label: 'remoteproj', sshTarget: 'me@host' },
];

const get = (xs: PastSessionByCwd[]) => () => xs;
const settle = (ms = 80) => new Promise<void>(r => setTimeout(r, ms));

describe('ResumeSearch (ink-testing-library)', () => {
  it('lists named sessions and excludes unnamed (no label/summary) ones', async () => {
    const { lastFrame, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alpha');         // labeled — shown
    expect(frame).toContain('remoteproj');    // labeled remote — shown
    expect(frame).toContain('(remote)');      // remote tag
    expect(frame).not.toContain('(unnamed)'); // unlabeled session filtered out
    expect(frame).not.toContain('zebra');     // its workspace not shown (session excluded)
    unmount();
  });

  it('fuzzy filters by label', async () => {
    const { stdin, lastFrame, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('alpha');
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alpha');
    expect(frame).not.toContain('(unnamed)');
    unmount();
  });

  it('does NOT fuzzy-search by workspace path (name-only search)', async () => {
    // 'projA' is s-alpha's cwd basename — searching it must not match (name-only).
    const { stdin, lastFrame, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('projA');
    await settle();
    expect(lastFrame()!).toContain('No match.');
    unmount();
  });

  it('shows multiple past sessions from the SAME cwd (no cwd dedup)', async () => {
    const sameCwd: PastSessionByCwd[] = [
      { sessionId: 's1', cwd: '/home/me/proj', startedAt: 2, label: 'first' },
      { sessionId: 's2', cwd: '/home/me/proj', startedAt: 1, label: 'second' },
    ];
    const { lastFrame, unmount } = render(
      <ResumeSearch getSessions={get(sameCwd)} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('first');
    expect(frame).toContain('second'); // both shown — not collapsed to one per cwd
    unmount();
  });

  it('shows empty state with no past sessions', async () => {
    const { lastFrame, unmount } = render(
      <ResumeSearch getSessions={get([])} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(lastFrame()!).toContain('No past sessions to resume.');
    unmount();
  });

  it('Enter selects the highlighted past session', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('\r');
    await settle();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].sessionId).toBe('s-alpha');
    unmount();
  });

  it('Esc cancels without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={onSelect} onCancel={onCancel} />,
    );
    await settle();
    stdin.write('\x1b');
    await settle();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('Enter on an empty (no-match) list is a no-op', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <ResumeSearch getSessions={get(past)} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write('zzzznomatch');
    await settle();
    stdin.write('\r');
    await settle();
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('re-snapshots the list when generation changes (scan-complete refresh)', async () => {
    let rows: PastSessionByCwd[] = [{ sessionId: 's1', cwd: '/p/a', startedAt: 1, label: 'oneonly' }];
    const getSessions = () => rows;
    const { lastFrame, rerender, unmount } = render(
      <ResumeSearch getSessions={getSessions} generation={0} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(lastFrame()).toContain('oneonly');
    expect(lastFrame()).not.toContain('twotwo');

    // Background scan finishes: getter now returns more rows; generation bumps.
    rows = [...rows, { sessionId: 's2', cwd: '/p/b', startedAt: 2, label: 'twotwo' }];
    rerender(<ResumeSearch getSessions={getSessions} generation={1} onSelect={vi.fn()} onCancel={vi.fn()} />);
    await settle();
    expect(lastFrame()).toContain('twotwo'); // re-ran useMemo on generation change
    unmount();
  });

  it('shows the scanning footer/empty-state while scan is in flight', async () => {
    const { lastFrame, unmount } = render(
      <ResumeSearch getSessions={get([])} generation={0} scanning={true} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(lastFrame()).toContain('Scanning all sessions…');
    unmount();
  });
});
