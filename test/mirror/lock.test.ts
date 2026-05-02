/**
 * Per-host lock unit tests — Tier 1.
 *
 * Verifies:
 *   - Concurrent `withHostLock(host, …)` invocations execute sequentially
 *     (not in parallel) for the same host.
 *   - Lock acquisition times out cleanly when held too long.
 *   - The lock file is created and removed predictably.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withHostLock, _lockPathForTest } from '../../src/mirror/lock.js';

let tmpdir: string;
const origRuntime = process.env['XDG_RUNTIME_DIR'];

beforeEach(() => {
  // Redirect lock dir into a per-test scratch dir so we never collide with
  // a real popmux instance, and so each test starts from a clean state.
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-lock-'));
  process.env['XDG_RUNTIME_DIR'] = tmpdir;
});

afterEach(() => {
  if (origRuntime !== undefined) process.env['XDG_RUNTIME_DIR'] = origRuntime;
  else delete process.env['XDG_RUNTIME_DIR'];
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe('withHostLock', () => {
  it('serializes concurrent calls for the same host', async () => {
    // BUT: lock.ts captures XDG_RUNTIME_DIR at module-load. We re-import
    // the module so it picks up the test's tmpdir.
    const { withHostLock: lockFn } = await import('../../src/mirror/lock.js?v=ser1' as string)
      .catch(async () => await import('../../src/mirror/lock.js'));

    const events: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
      return label;
    };

    const [a, b] = await Promise.all([
      lockFn('host1', slow('a', 50)),
      lockFn('host1', slow('b', 50)),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');

    // Either a-then-b or b-then-a, but never interleaved.
    const ai = events.indexOf('a:start');
    const ae = events.indexOf('a:end');
    const bi = events.indexOf('b:start');
    const be = events.indexOf('b:end');
    const interleaved = (ai < bi && bi < ae) || (bi < ai && ai < be);
    expect(interleaved).toBe(false);
  });

  it('does not serialize across different hosts', async () => {
    const events: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    };

    const start = Date.now();
    await Promise.all([
      withHostLock('hostA', slow('a', 60)),
      withHostLock('hostB', slow('b', 60)),
    ]);
    const elapsed = Date.now() - start;
    // If serialized: ~120ms. Parallel: ~60-90ms. Use 100ms as a generous
    // upper bound that still distinguishes the two.
    expect(elapsed).toBeLessThan(110);
  });

  it('removes the lock file after successful execution', async () => {
    const lockFile = _lockPathForTest('cleanup-host');
    await withHostLock('cleanup-host', async () => {
      // While holding, file should exist
      expect(fs.existsSync(lockFile)).toBe(true);
    });
    // After return, file should be gone
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('removes the lock file even if fn throws', async () => {
    const lockFile = _lockPathForTest('throw-host');
    await expect(
      withHostLock('throw-host', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('times out when lock cannot be acquired', async () => {
    // Hold the lock with a slow fn, then race a second caller with a tight timeout.
    let release: (() => void) | null = null;
    const holding = withHostLock('busy-host', async () => {
      await new Promise<void>((r) => { release = r; });
    });
    // Wait briefly to ensure the holder created the lock file
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      withHostLock('busy-host', async () => 'never', { timeoutMs: 80, pollIntervalMs: 20 }),
    ).rejects.toThrow(/Timed out acquiring mirror lock/);

    // Let the first holder finish so cleanup runs.
    release!();
    await holding;
  });
});
