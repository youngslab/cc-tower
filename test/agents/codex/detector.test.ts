import { describe, expect, it } from 'vitest';
import { discoverCodexSessions } from '../../../src/agents/codex/detector.js';
import type { CodexThreadRow, ProcReader, ProcessRow } from '../../../src/agents/codex/types.js';

function procReader(cwdByPid: Map<number, string>, envByPid: Map<number, Record<string, string>> = new Map()): ProcReader {
  return {
    readCwd(pid: number): string | null {
      return cwdByPid.get(pid) ?? null;
    },
    readEnv(pid: number, name: string): string | null {
      return envByPid.get(pid)?.[name] ?? null;
    },
  };
}

describe('codex live detector metadata labels', () => {
  it('withholds same-cwd SQLite titles from live dashboard labels when the match is not authoritative', async () => {
    const cwdByPid = new Map<number, string>([
      [101, '/repo'],
      [102, '/repo'],
    ]);
    const processes: ProcessRow[] = [
      { pid: 101, ppid: 1, tty: '/dev/pts/1', command: 'codex', args: '/usr/bin/codex -C /repo' },
      { pid: 102, ppid: 1, tty: '/dev/pts/2', command: 'codex', args: '/usr/bin/codex -C /repo' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'thread-new', cwd: '/repo', title: 'Newest unrelated prompt', updatedAt: 3 },
      { id: 'thread-old', cwd: '/repo', title: 'Older unrelated prompt', updatedAt: 1 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid), threads });

    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: 'codex-proc-101', cwd: '/repo', label: undefined, labelSource: undefined, metadataConfidence: 'medium', resumable: false }),
      expect.objectContaining({ sessionId: 'codex-proc-102', cwd: '/repo', label: undefined, labelSource: undefined, metadataConfidence: 'medium', resumable: false }),
    ]);
  });

  it('keeps Codex rename labels when an exact resume thread id gives high confidence', async () => {
    const cwdByPid = new Map<number, string>([[201, '/repo']]);
    const processes: ProcessRow[] = [
      { pid: 201, ppid: 1, tty: '/dev/pts/3', command: 'codex', args: '/usr/bin/codex resume thread-1 -C /repo' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'thread-1', cwd: '/repo', title: 'Authoritative resumed task', name: 'User Rename', updatedAt: 5 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'thread-1',
        resumeId: 'thread-1',
        resumable: true,
        label: 'User Rename',
        labelSource: 'codex-rename',
        metadataConfidence: 'high',
      }),
    ]);
  });

  it('exposes Codex rename titles for codex resume without an explicit thread id', async () => {
    const cwdByPid = new Map<number, string>([[225, '/repo']]);
    const processes: ProcessRow[] = [
      {
        pid: 225,
        ppid: 1,
        tty: '/dev/pts/6',
        command: 'codex',
        args: '/usr/bin/codex resume --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=high -C /repo',
      },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'older-thread', cwd: '/repo', title: 'Generated prompt title', updatedAt: 1 },
      { id: 'latest-resumed-thread', cwd: '/repo', title: 'cc-tower', preview: 'Codex rename dashboard work', updatedAt: 5 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'latest-resumed-thread',
        resumeId: 'latest-resumed-thread',
        launchKind: 'resume',
        label: 'cc-tower',
        labelSource: 'codex-rename',
        goalSummary: 'Codex rename dashboard work',
        metadataConfidence: 'high',
        resumable: true,
      }),
    ]);
  });

  it('does not expose generated Codex titles as live dashboard labels without a user rename', async () => {
    const cwdByPid = new Map<number, string>([[250, '/repo']]);
    const processes: ProcessRow[] = [
      { pid: 250, ppid: 1, tty: '/dev/pts/5', command: 'codex', args: '/usr/bin/codex resume thread-title-only -C /repo' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'thread-title-only', cwd: '/repo', title: 'Generated title only', updatedAt: 5 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'thread-title-only',
        resumeId: 'thread-title-only',
        label: undefined,
        labelSource: undefined,
        metadataConfidence: 'high',
        resumable: true,
      }),
    ]);
  });

  it('exposes a Codex title rename for a fresh process matched by OMX session start time', async () => {
    const cwdByPid = new Map<number, string>([[275, '/home/me']]);
    const envByPid = new Map<number, Record<string, string>>([
      [275, { OMX_SESSION_ID: 'omx-2000001000000-travel' }],
    ]);
    const processes: ProcessRow[] = [
      { pid: 275, ppid: 1, tty: '/dev/pts/7', command: 'codex', args: '/usr/bin/codex -C /home/me' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'travel-thread', cwd: '/home/me', title: 'travel', preview: 'gws를 설치하고 싶어', firstUserMessage: 'gws를 설치하고 싶어', createdAt: 2000001001, updatedAt: 2 },
      { id: 'newer-unrelated', cwd: '/home/me', title: 'Newest unrelated prompt', preview: '다른 작업', createdAt: 2000005000, updatedAt: 3 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid, envByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'travel-thread',
        resumeId: 'travel-thread',
        label: 'travel',
        labelSource: 'codex-rename',
        goalSummary: 'gws를 설치하고 싶어',
        metadataConfidence: 'high',
        resumable: true,
      }),
    ]);
  });

  it('uses OMX_SESSION_ID start time to expose a user rename for a process pseudo session safely', async () => {
    const cwdByPid = new Map<number, string>([[301, '/repo']]);
    const envByPid = new Map<number, Record<string, string>>([
      [301, { OMX_SESSION_ID: 'omx-2000001000000-abcd12' }],
    ]);
    const processes: ProcessRow[] = [
      { pid: 301, ppid: 1, tty: '/dev/pts/4', command: 'codex', args: '/usr/bin/codex -C /repo' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'matching-thread', cwd: '/repo', title: 'Auto title', name: 'User Rename', createdAt: 2000001001, updatedAt: 2 },
      { id: 'newer-unrelated', cwd: '/repo', title: 'Newest unrelated prompt', name: 'Wrong Rename', createdAt: 2000005000, updatedAt: 3 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid, envByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'matching-thread',
        resumeId: 'matching-thread',
        label: 'User Rename',
        labelSource: 'codex-rename',
        metadataConfidence: 'high',
        resumable: true,
      }),
    ]);
  });

});
