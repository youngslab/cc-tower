import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscoveryEngine, type SessionInfo } from '../../src/core/discovery.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cc-tower-discovery-'));
}

describe('DiscoveryEngine', () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    sessionsDir = join(tmpDir, 'sessions');
    await mkdir(sessionsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('scanOnce returns empty array when no session files', async () => {
    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    const sessions = await engine.scanOnce();
    expect(sessions).toEqual([]);
  });

  it('scanOnce finds a valid session with a live PID', async () => {
    const pid = process.pid;
    const info: SessionInfo = {
      pid,
      sessionId: 'test-session-uuid',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    };
    await writeFile(join(sessionsDir, `${pid}.json`), JSON.stringify(info));

    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    const found: SessionInfo[] = [];
    engine.on('session-found', (s: SessionInfo) => found.push(s));

    const sessions = await engine.scanOnce();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pid).toBe(pid);
    expect(sessions[0]!.sessionId).toBe('test-session-uuid');
    expect(found).toHaveLength(1);
    expect(found[0]!.pid).toBe(pid);
  });

  it('scanOnce does not emit session-found twice for same PID', async () => {
    const pid = process.pid;
    const info: SessionInfo = {
      pid,
      sessionId: 'stable-session',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    };
    await writeFile(join(sessionsDir, `${pid}.json`), JSON.stringify(info));

    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    const found: SessionInfo[] = [];
    engine.on('session-found', (s: SessionInfo) => found.push(s));

    await engine.scanOnce();
    await engine.scanOnce();

    expect(found).toHaveLength(1);
  });

  it('scanOnce skips dead PIDs and does not emit session-found', async () => {
    // Use a very high PID that almost certainly does not exist
    const deadPid = 9999999;
    const info: SessionInfo = {
      pid: deadPid,
      sessionId: 'dead-session',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    };
    await writeFile(join(sessionsDir, `${deadPid}.json`), JSON.stringify(info));

    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    const found: SessionInfo[] = [];
    engine.on('session-found', (s: SessionInfo) => found.push(s));

    const sessions = await engine.scanOnce();

    expect(sessions).toHaveLength(0);
    expect(found).toHaveLength(0);
  });

  it('emits session-lost when a previously known PID is no longer alive', async () => {
    // First, register a live session manually by scanning with our own PID
    const pid = process.pid;
    const info: SessionInfo = {
      pid,
      sessionId: 'live-then-dead',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    };
    const sessionFile = join(sessionsDir, `${pid}.json`);
    await writeFile(sessionFile, JSON.stringify(info));

    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    await engine.scanOnce(); // registers PID as known

    // Now replace file with a dead PID to simulate process death
    const deadPid = 9999999;
    const deadInfo: SessionInfo = { ...info, pid: deadPid };
    // Remove the live file and inject dead one
    await rm(sessionFile);
    await writeFile(join(sessionsDir, `${deadPid}.json`), JSON.stringify(deadInfo));

    // Simulate the engine knowing about the dead pid by directly registering it
    // We do this by accessing private known map via a fresh scan that first sees it alive,
    // then re-scan after "death". Instead, test the direct path: write dead PID file, scan.
    const engine2 = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    // Manually seed known map via first scan seeing it — but PID 9999999 is dead,
    // so we can't do that. Test the emit path by injecting into known directly.
    // Cast to any to access private for test purposes:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine2 as any).known.set(deadPid, deadInfo);

    const lost: SessionInfo[] = [];
    engine2.on('session-lost', (s: SessionInfo) => lost.push(s));
    await engine2.scanOnce();

    expect(lost).toHaveLength(1);
    expect(lost[0]!.pid).toBe(deadPid);
  });

  it('scanOnce skips malformed JSON files without crashing', async () => {
    await writeFile(join(sessionsDir, 'bad.json'), 'not valid json {{');
    await writeFile(join(sessionsDir, 'missing-fields.json'), '{"pid": 123}'); // missing sessionId/cwd/startedAt

    const engine = new DiscoveryEngine({ scan_interval: 1000, claude_dir: tmpDir });
    const sessions = await engine.scanOnce();
    expect(sessions).toHaveLength(0);
  });

  it('scanOnce handles missing sessions directory gracefully', async () => {
    const engine = new DiscoveryEngine({
      scan_interval: 1000,
      claude_dir: join(tmpDir, 'nonexistent'),
    });
    const sessions = await engine.scanOnce();
    expect(sessions).toEqual([]);
  });

  it('start and stop control the interval', () => {
    const engine = new DiscoveryEngine({ scan_interval: 10000, claude_dir: tmpDir });
    engine.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).interval).not.toBeNull();
    engine.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).interval).toBeNull();
  });
});
