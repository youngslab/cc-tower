import { describe, expect, it } from 'vitest';
import { discoverCodexSessions } from '../../../src/agents/codex/detector.js';
import type { CodexThreadRow, ProcReader, ProcessRow } from '../../../src/agents/codex/types.js';

function procReader(cwdByPid: Map<number, string>): ProcReader {
  return {
    readCwd(pid: number): string | null {
      return cwdByPid.get(pid) ?? null;
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

  it('keeps Codex SQLite title labels when an exact resume thread id gives high confidence', async () => {
    const cwdByPid = new Map<number, string>([[201, '/repo']]);
    const processes: ProcessRow[] = [
      { pid: 201, ppid: 1, tty: '/dev/pts/3', command: 'codex', args: '/usr/bin/codex resume thread-1 -C /repo' },
    ];
    const threads: CodexThreadRow[] = [
      { id: 'thread-1', cwd: '/repo', title: 'Authoritative resumed task', updatedAt: 5 },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader(cwdByPid), threads });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'thread-1',
        resumeId: 'thread-1',
        resumable: true,
        label: 'Authoritative resumed task',
        labelSource: 'codex-title',
        metadataConfidence: 'high',
      }),
    ]);
  });
});
