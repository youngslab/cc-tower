import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Dashboard } from '../../src/ui/Dashboard.js';
import type { Session } from '../../src/core/session-store.js';

function session(overrides: Partial<Session>): Session {
  return {
    pid: 100,
    paneId: '%100',
    sessionId: 'sid',
    hasTmux: true,
    detectionMode: 'jsonl',
    cwd: '/repo/app',
    projectName: 'app',
    status: 'idle',
    lastActivity: new Date(),
    startedAt: new Date(),
    messageCount: 0,
    toolCallCount: 0,
    host: 'local',
    ...overrides,
  } as Session;
}

describe('Dashboard agent coexistence', () => {
  it('renders live Claude and Codex sessions together in one flat list with badges', async () => {
    const { lastFrame, unmount } = render(
      <Dashboard
        sessions={[
          session({ agentId: 'claude', pid: 101, paneId: '%101', sessionId: 'claude-live', projectName: 'repo-a', cwd: '/repo/a' }),
          session({ agentId: 'codex', pid: 102, paneId: '%102', sessionId: 'codex-live', projectName: 'repo-b', cwd: '/repo/b', detectionMode: 'process' }),
        ]}
        tmuxCount={2}
        maxTaskWidth={80}
        termWidth={120}
        termHeight={40}
        headerHeight={0}
        cursorIdentity={null}
        onCursorChange={vi.fn()}
        onSwapFavoriteOrder={vi.fn()}
        onSelect={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenResumeSearch={vi.fn()}
        onToggleFavorite={vi.fn()}
        onNewSession={vi.fn()}
        onRefresh={vi.fn()}
        onKill={vi.fn()}
        onGo={vi.fn()}
        onDisplayOrderChange={vi.fn()}
        initialDisplayOrder={[]}
        onQuit={vi.fn()}
      />,
    );

    const frame = lastFrame()!;
    expect(frame).toContain('Ⓒ repo-a');
    expect(frame).toContain('Ⓧ repo-b');
    expect(frame).toContain('Ⓒ Claude Ⓧ Codex');
    unmount();
  });

});
