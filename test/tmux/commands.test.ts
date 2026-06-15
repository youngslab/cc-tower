import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa module before importing the module under test
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { tmux } from '../../src/tmux/commands.js';

const mockExeca = vi.mocked(execa);

function makeExecaResult(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 } as ReturnType<typeof execa> extends Promise<infer R> ? R : never;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('tmux.listPanes', () => {
  it('parses a single pane line correctly', async () => {
    const line = '%5\t/dev/pts/34\t1234\tbash\t/home/user/project\t220\t50\t1\t@1\t0\tmain';
    mockExeca.mockResolvedValueOnce(makeExecaResult(line) as never);

    const panes = await tmux.listPanes();
    expect(panes).toHaveLength(1);
    const pane = panes[0]!;
    expect(pane.paneId).toBe('%5');
    expect(pane.tty).toBe('/dev/pts/34');
    expect(pane.pid).toBe(1234);
    expect(pane.currentCommand).toBe('bash');
    expect(pane.currentPath).toBe('/home/user/project');
    expect(pane.width).toBe(220);
    expect(pane.height).toBe(50);
    expect(pane.active).toBe(true);
    expect(pane.windowId).toBe('@1');
    expect(pane.windowIndex).toBe(0);
    expect(pane.sessionName).toBe('main');
  });

  it('parses multiple pane lines', async () => {
    const lines = [
      '%1\t/dev/pts/1\t100\tnode\t/home/user/app\t200\t40\t1\t@0\t0\twork',
      '%2\t/dev/pts/2\t101\tnvim\t/home/user/other\t200\t40\t0\t@0\t0\twork',
    ].join('\n');
    mockExeca.mockResolvedValueOnce(makeExecaResult(lines) as never);

    const panes = await tmux.listPanes();
    expect(panes).toHaveLength(2);
    expect(panes[0]!.paneId).toBe('%1');
    expect(panes[0]!.active).toBe(true);
    expect(panes[1]!.paneId).toBe('%2');
    expect(panes[1]!.active).toBe(false);
  });

  it('skips malformed lines', async () => {
    const lines = [
      '%1\t/dev/pts/1\t100\tbash\t/home\t80\t24\t1\t@0\t0\tmain',
      'not-enough-fields',
      '%3\t/dev/pts/3\t102\tzsh\t/tmp\t80\t24\t0\t@0\t1\tmain',
    ].join('\n');
    mockExeca.mockResolvedValueOnce(makeExecaResult(lines) as never);

    const panes = await tmux.listPanes();
    expect(panes).toHaveLength(2);
    expect(panes[0]!.paneId).toBe('%1');
    expect(panes[1]!.paneId).toBe('%3');
  });

  it('returns empty array when stdout is empty', async () => {
    mockExeca.mockResolvedValueOnce(makeExecaResult('') as never);
    const panes = await tmux.listPanes();
    expect(panes).toHaveLength(0);
  });

  it('throws descriptive error when execa fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('tmux: no server running') as never);
    await expect(tmux.listPanes()).rejects.toThrow('tmux list-panes failed');
  });
});

describe('tmux.isAvailable', () => {
  it('returns false when not inside a tmux session', async () => {
    const originalTmux = process.env['TMUX'];
    delete process.env['TMUX'];
    mockExeca.mockResolvedValueOnce(makeExecaResult('') as never);
    const result = await tmux.isAvailable();
    expect(result).toBe(false);
    if (originalTmux !== undefined) process.env['TMUX'] = originalTmux;
  });

  it('returns true when inside a tmux session', async () => {
    const originalTmux = process.env['TMUX'];
    process.env['TMUX'] = '/tmp/tmux-1000/default,12345,0';
    mockExeca.mockResolvedValueOnce(makeExecaResult('') as never);
    const result = await tmux.isAvailable();
    expect(result).toBe(true);
    if (originalTmux !== undefined) {
      process.env['TMUX'] = originalTmux;
    } else {
      delete process.env['TMUX'];
    }
  });

  it('returns false when execa throws', async () => {
    const originalTmux = process.env['TMUX'];
    process.env['TMUX'] = '/tmp/tmux-1000/default,12345,0';
    mockExeca.mockRejectedValueOnce(new Error('command not found: tmux') as never);
    const result = await tmux.isAvailable();
    expect(result).toBe(false);
    if (originalTmux !== undefined) {
      process.env['TMUX'] = originalTmux;
    } else {
      delete process.env['TMUX'];
    }
  });
});

describe('tmux.getCurrentPane', () => {
  it('returns windowId and paneId on success', async () => {
    mockExeca.mockResolvedValueOnce(makeExecaResult('@2\t%7') as never);
    const result = await tmux.getCurrentPane();
    expect(result).toEqual({ windowId: '@2', paneId: '%7' });
  });

  it('returns null when execa fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('not in tmux') as never);
    const result = await tmux.getCurrentPane();
    expect(result).toBeNull();
  });

  it('returns null on unexpected output format', async () => {
    mockExeca.mockResolvedValueOnce(makeExecaResult('') as never);
    const result = await tmux.getCurrentPane();
    expect(result).toBeNull();
  });
});

describe('tmux.sendKeys', () => {
  it('calls execa with correct args', async () => {
    mockExeca.mockResolvedValueOnce(makeExecaResult('') as never);
    await tmux.sendKeys('%3', 'echo hello');
    expect(mockExeca).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '%3', 'echo hello', 'Enter']);
  });

  it('throws descriptive error on failure', async () => {
    mockExeca.mockRejectedValueOnce(new Error('can\'t find pane') as never);
    await expect(tmux.sendKeys('%99', 'test')).rejects.toThrow('tmux send-keys to %99 failed');
  });
});
