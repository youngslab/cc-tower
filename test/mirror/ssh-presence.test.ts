/**
 * isSshAlive unit tests — Tier 1.
 *
 * `execa` is mocked module-wide. Tests verify the two-step detection logic:
 *   1. ps -p <pid> -o comm= — is the pane process itself ssh?
 *   2. pgrep -P <pid> -x ssh — does the pane have a direct ssh child?
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { isSshAlive } from '../../src/mirror/ssh-presence.js';

const mockExeca = vi.mocked(execa);

type ExecaResult = { stdout: string; stderr: string; exitCode: number };
function ok(stdout = ''): ExecaResult { return { stdout, stderr: '', exitCode: 0 }; }
function fail(stdout = ''): ExecaResult { return { stdout, stderr: '', exitCode: 1 }; }

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isSshAlive', () => {
  it('returns true when ps reports comm=ssh (pane process IS ssh itself)', async () => {
    mockExeca.mockResolvedValueOnce(ok('ssh\n') as never);
    expect(await isSshAlive(1234)).toBe(true);
    // pgrep should NOT be called — we short-circuit after ps succeeds
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith('ps', ['-p', '1234', '-o', 'comm='], { reject: false });
  });

  it('returns true when pgrep -P finds an ssh child process', async () => {
    mockExeca
      .mockResolvedValueOnce(ok('bash\n') as never)   // ps: pane is bash, not ssh
      .mockResolvedValueOnce(ok('5678\n') as never);  // pgrep: ssh child found
    expect(await isSshAlive(1234)).toBe(true);
    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockExeca).toHaveBeenNthCalledWith(2, 'pgrep', ['-P', '1234', '-x', 'ssh'], { reject: false });
  });

  it('returns false when ps shows non-ssh AND pgrep finds no ssh child', async () => {
    mockExeca
      .mockResolvedValueOnce(ok('bash\n') as never)  // ps: bash
      .mockResolvedValueOnce(fail() as never);        // pgrep: nothing
    expect(await isSshAlive(1234)).toBe(false);
  });

  it('returns false for pid = 0', async () => {
    expect(await isSshAlive(0)).toBe(false);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('returns false for negative pid', async () => {
    expect(await isSshAlive(-1)).toBe(false);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('returns false for NaN pid', async () => {
    expect(await isSshAlive(NaN)).toBe(false);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('falls through to pgrep when ps throws', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('ps not found') as never)  // ps throws
      .mockResolvedValueOnce(ok('9999\n') as never);               // pgrep: ssh child found
    expect(await isSshAlive(1234)).toBe(true);
  });

  it('returns false when both ps throws and pgrep throws', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('ps error') as never)
      .mockRejectedValueOnce(new Error('pgrep error') as never);
    expect(await isSshAlive(1234)).toBe(false);
  });
});
