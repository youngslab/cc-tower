import { describe, expect, it } from 'vitest';
import {
  discoverCodexSessions,
  isCodexNodeWrapper,
  isInteractiveCodex,
  isNativeCodex,
  mapProcessToPane,
  parsePsOutput,
  parseTmuxPanes,
} from '../../experiments/codex-mvp/discover.js';
import type { PaneSnapshot, ProcessRow } from '../../experiments/codex-mvp/types.js';

const cwdByPid = new Map<number, string>([
  [101, '/home/user/workspace/popmux'],
  [102, '/home/user/workspace/popmux'],
  [201, '/home/user/workspace/exec-task'],
  [301, '/home/user/workspace/review-task'],
  [401, '/home/user/workspace/resumed'],
]);

function procReader() {
  return {
    readCwd(pid: number): string | null {
      return cwdByPid.get(pid) ?? null;
    },
  };
}

describe('codex MVP process parsing', () => {
  it('parses ps rows with pid, ppid, tty, command, and args', () => {
    const rows = parsePsOutput('  102  101 pts/3 codex /opt/codex/bin/codex -C /repo\n  101    1 ? node node /usr/bin/codex\n');

    expect(rows).toEqual([
      { pid: 102, ppid: 101, tty: '/dev/pts/3', command: 'codex', args: '/opt/codex/bin/codex -C /repo' },
      { pid: 101, ppid: 1, tty: undefined, command: 'node', args: 'node /usr/bin/codex' },
    ]);
  });

  it('parses tmux pane snapshots', () => {
    const panes = parseTmuxPanes('%7\t/dev/pts/3\t100\tnode\t/home/user/workspace/popmux\t2\tmain\n');

    expect(panes).toEqual([
      {
        paneId: '%7',
        tty: '/dev/pts/3',
        pid: 100,
        currentCommand: 'node',
        currentPath: '/home/user/workspace/popmux',
        windowIndex: 2,
        sessionName: 'main',
      },
    ]);
  });
});

describe('codex MVP process classification', () => {
  it('recognizes native codex and node wrapper processes', () => {
    const native: ProcessRow = { pid: 10, ppid: 9, command: 'codex', args: '/opt/codex/codex', tty: '/dev/pts/1' };
    const wrapper: ProcessRow = { pid: 9, ppid: 1, command: 'node', args: 'node /usr/bin/codex', tty: '/dev/pts/1' };

    expect(isNativeCodex(native)).toBe(true);
    expect(isCodexNodeWrapper(wrapper)).toBe(true);
  });

  it('skips non-interactive codex subcommands but allows resume', () => {
    expect(isInteractiveCodex({ pid: 1, ppid: 0, command: 'codex', args: '/usr/bin/codex exec "fix it"' })).toBe(false);
    expect(isInteractiveCodex({ pid: 2, ppid: 0, command: 'codex', args: '/usr/bin/codex review' })).toBe(false);
    expect(isInteractiveCodex({ pid: 5, ppid: 0, command: 'codex', args: '/usr/bin/codex --help' })).toBe(false);
    expect(isInteractiveCodex({ pid: 3, ppid: 0, command: 'codex', args: '/usr/bin/codex resume abc123' })).toBe(true);
    expect(isInteractiveCodex({ pid: 4, ppid: 0, command: 'codex', args: '/usr/bin/codex -C /repo' })).toBe(true);
  });
});

describe('codex MVP discovery', () => {
  it('detects a native interactive codex process and maps it through the wrapper to a tmux pane', async () => {
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 1, tty: '/dev/pts/3', command: 'zsh', args: 'zsh' },
      { pid: 101, ppid: 100, tty: '/dev/pts/3', command: 'node', args: 'node /usr/bin/codex -C /home/user/workspace/popmux' },
      { pid: 102, ppid: 101, tty: '/dev/pts/3', command: 'codex', args: '/opt/codex/codex -C /home/user/workspace/popmux' },
    ];
    const panes: PaneSnapshot[] = [
      { paneId: '%7', tty: '/dev/pts/3', pid: 100, currentPath: '/home/user/workspace/popmux', windowIndex: 1, sessionName: 'dev' },
    ];

    const sessions = await discoverCodexSessions({ processes, panes, procReader: procReader() });

    expect(sessions).toEqual([
      expect.objectContaining({
        agentId: 'codex',
        sessionId: 'codex-proc-102',
        pid: 102,
        wrapperPid: 101,
        cwd: '/home/user/workspace/popmux',
        projectName: 'popmux',
        paneId: '%7',
        tmuxSession: 'dev',
        windowIndex: 1,
        launchKind: 'fresh',
      }),
    ]);
  });

  it('does not duplicate wrapper and native child processes', async () => {
    const processes: ProcessRow[] = [
      { pid: 101, ppid: 1, tty: '/dev/pts/3', command: 'node', args: 'node /usr/bin/codex' },
      { pid: 102, ppid: 101, tty: '/dev/pts/3', command: 'codex', args: '/opt/codex/codex' },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader() });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pid).toBe(102);
  });

  it('skips codex exec and review processes', async () => {
    const processes: ProcessRow[] = [
      { pid: 201, ppid: 1, tty: '/dev/pts/4', command: 'codex', args: '/usr/bin/codex exec "summarize"' },
      { pid: 301, ppid: 1, tty: '/dev/pts/5', command: 'codex', args: '/usr/bin/codex review' },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader() });

    expect(sessions).toEqual([]);
  });

  it('uses a real resume thread id when codex resume includes one', async () => {
    const processes: ProcessRow[] = [
      { pid: 401, ppid: 1, tty: '/dev/pts/6', command: 'codex', args: '/usr/bin/codex resume thread-abc -C /home/user/workspace/resumed' },
    ];

    const sessions = await discoverCodexSessions({ processes, procReader: procReader() });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'thread-abc',
        resumeThreadId: 'thread-abc',
        launchKind: 'resume',
      }),
    ]);
  });

  it('maps processes to panes by direct pid, ancestor pid, or tty', () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, command: 'zsh', args: 'zsh', tty: '/dev/pts/9' },
      { pid: 20, ppid: 10, command: 'node', args: 'node /usr/bin/codex', tty: '/dev/pts/9' },
      { pid: 30, ppid: 20, command: 'codex', args: '/usr/bin/codex', tty: '/dev/pts/9' },
    ];
    const byPid = new Map(rows.map((row) => [row.pid, row]));

    expect(mapProcessToPane(rows[2]!, byPid, [{ paneId: '%direct', tty: '/dev/pts/8', pid: 30 }])?.paneId).toBe('%direct');
    expect(mapProcessToPane(rows[2]!, byPid, [{ paneId: '%ancestor', tty: '/dev/pts/8', pid: 10 }])?.paneId).toBe('%ancestor');
    expect(mapProcessToPane(rows[2]!, byPid, [{ paneId: '%tty', tty: '/dev/pts/9', pid: 999 }])?.paneId).toBe('%tty');
  });
});
