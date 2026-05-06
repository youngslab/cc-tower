/**
 * Window manager unit tests — Tier 1.
 *
 * `execa` is mocked module-wide. Each test wires up the responses the real
 * subprocess pipeline would have produced. We only assert behavior on the
 * boundary (which tmux / pgrep / ps commands were called, with what args).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock execa BEFORE importing modules that depend on it.
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  slugPaneId,
  unslugPaneId,
  windowName,
  parseWindowName,
  isMirrorAlive,
  cleanupDeadMirrors,
  cleanupStaleMirrors,
  listMirrors,
  MIRROR_SESSION,
} from '../../src/mirror/window-manager.js';
import { touchActivity, activityPath } from '../../src/mirror/activity.js';

const mockExeca = vi.mocked(execa);

type ExecaResult = { stdout: string; stderr: string; exitCode: number };
function ok(stdout = ''): ExecaResult { return { stdout, stderr: '', exitCode: 0 }; }
function fail(): ExecaResult { return { stdout: '', stderr: 'no such session', exitCode: 1 }; }

let tmpdir: string;
const origRuntime = process.env['XDG_RUNTIME_DIR'];

beforeEach(() => {
  vi.resetAllMocks();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-wm-'));
  process.env['XDG_RUNTIME_DIR'] = tmpdir;
});

afterEach(() => {
  if (origRuntime !== undefined) process.env['XDG_RUNTIME_DIR'] = origRuntime;
  else delete process.env['XDG_RUNTIME_DIR'];
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

// ── Naming helpers ──────────────────────────────────────────────────────────

describe('slugPaneId / unslugPaneId / windowName', () => {
  it('slugPaneId converts "%5" → "pct5"', () => {
    expect(slugPaneId('%5')).toBe('pct5');
  });
  it('slugPaneId converts "%12" → "pct12"', () => {
    expect(slugPaneId('%12')).toBe('pct12');
  });
  it('slugPaneId strips disallowed chars', () => {
    expect(slugPaneId('weird/pane?')).toBe('weird_pane_');
  });
  it('unslugPaneId is inverse for "pct<digits>"', () => {
    expect(unslugPaneId('pct5')).toBe('%5');
    expect(unslugPaneId('pct12')).toBe('%12');
  });
  it('windowName composes correctly', () => {
    expect(windowName('server-a', '%5')).toBe('mirror-server-a-pct5');
    expect(windowName('host_b', '%12')).toBe('mirror-host_b-pct12');
  });
  it('parseWindowName recovers (host, pane)', () => {
    expect(parseWindowName('mirror-server-a-pct5')).toEqual({ host: 'server-a', pane: '%5' });
    expect(parseWindowName('mirror-h.with.dots-pct42')).toEqual({ host: 'h.with.dots', pane: '%42' });
  });
  it('parseWindowName returns null on non-mirror prefix', () => {
    expect(parseWindowName('something-else')).toBeNull();
    expect(parseWindowName('claude-popmux')).toBeNull();
  });
});

// ── isMirrorAlive: 4 cases (per acceptance) ────────────────────────────────

describe('isMirrorAlive — 3-condition aliveness check', () => {
  it('returns false when window does not exist', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-other-pct1') as never);
    expect(await isMirrorAlive('server-a', '%5')).toBe(false);
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith('tmux',
      ['list-windows', '-t', MIRROR_SESSION, '-F', '#W'], { reject: false });
  });

  it('returns false when pane is dead (pane_dead=1)', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-server-a-pct5') as never); // list-windows
    mockExeca.mockResolvedValueOnce(ok('1|99999') as never);                // list-panes (dead)
    expect(await isMirrorAlive('server-a', '%5')).toBe(false);
  });

  it('returns false when pane is alive but no ssh child exists', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-server-a-pct5') as never); // list-windows
    mockExeca.mockResolvedValueOnce(ok('0|12345') as never);                // list-panes (alive)
    mockExeca.mockResolvedValueOnce(ok('bash') as never);                   // ps -p (not ssh)
    mockExeca.mockResolvedValueOnce(fail() as never);                       // pgrep (no ssh)
    expect(await isMirrorAlive('server-a', '%5')).toBe(false);
  });

  it('returns true when window+pane+ssh-child all healthy', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-server-a-pct5') as never); // list-windows
    mockExeca.mockResolvedValueOnce(ok('0|12345') as never);                // list-panes (alive)
    mockExeca.mockResolvedValueOnce(ok('bash') as never);                   // ps -p (not ssh self)
    mockExeca.mockResolvedValueOnce(ok('99999\n') as never);                // pgrep (ssh child found)
    expect(await isMirrorAlive('server-a', '%5')).toBe(true);
  });

  it('returns true when pane process IS ssh itself (no shell wrapper)', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-server-a-pct5') as never); // list-windows
    mockExeca.mockResolvedValueOnce(ok('0|12345') as never);                // list-panes
    mockExeca.mockResolvedValueOnce(ok('ssh') as never);                    // ps -p (IS ssh)
    expect(await isMirrorAlive('server-a', '%5')).toBe(true);
  });
});

// ── cleanupDeadMirrors ─────────────────────────────────────────────────────

describe('cleanupDeadMirrors', () => {
  it('kills mirror windows whose pane is dead', async () => {
    // first call: enumerate mirror windows
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct1\nmirror-h2-pct2') as never);
    // isMirrorAlive(h1) → window list, panes dead
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct1\nmirror-h2-pct2') as never);
    mockExeca.mockResolvedValueOnce(ok('1|111') as never);
    // kill-window h1
    mockExeca.mockResolvedValueOnce(ok() as never);
    // isMirrorAlive(h2) → window list, panes alive, ps says ssh
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct1\nmirror-h2-pct2') as never);
    mockExeca.mockResolvedValueOnce(ok('0|222') as never);
    mockExeca.mockResolvedValueOnce(ok('ssh') as never);

    const killed = await cleanupDeadMirrors();
    expect(killed).toEqual(['mirror-h1-pct1']);
    expect(mockExeca).toHaveBeenCalledWith(
      'tmux', ['kill-window', '-t', `${MIRROR_SESSION}:mirror-h1-pct1`], { reject: false },
    );
  });

  it('returns empty list when no mirror windows exist', async () => {
    mockExeca.mockResolvedValueOnce(ok('') as never);
    expect(await cleanupDeadMirrors()).toEqual([]);
  });
});

// ── listMirrors ────────────────────────────────────────────────────────────

describe('listMirrors', () => {
  it('returns records with alive flag for each mirror window', async () => {
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct5') as never);          // top-level list
    // isMirrorAlive(h1) → window list, panes alive, ps ssh
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct5') as never);
    mockExeca.mockResolvedValueOnce(ok('0|123') as never);
    mockExeca.mockResolvedValueOnce(ok('ssh') as never);

    const records = await listMirrors();
    expect(records).toHaveLength(1);
    expect(records[0]!.window).toBe('mirror-h1-pct5');
    expect(records[0]!.host).toBe('h1');
    expect(records[0]!.pane).toBe('%5');
    expect(records[0]!.alive).toBe(true);
  });
});

// ── cleanupStaleMirrors ────────────────────────────────────────────────────

describe('cleanupStaleMirrors', () => {
  it('evicts windows whose activity mtime is older than TTL', async () => {
    // Create a real activity marker with mtime set to 31 minutes ago.
    touchActivity('h1', '%5');
    const p = activityPath('h1', '%5');
    const staleTime = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(p, staleTime, staleTime);

    // list-windows returns one mirror window for h1/%5
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct5') as never);
    // kill-window
    mockExeca.mockResolvedValueOnce(ok() as never);

    const killed = await cleanupStaleMirrors({ ttlMs: 30 * 60 * 1000 });
    expect(killed).toEqual(['mirror-h1-pct5']);
    expect(mockExeca).toHaveBeenCalledWith(
      'tmux', ['kill-window', '-t', `${MIRROR_SESSION}:mirror-h1-pct5`], { reject: false },
    );
  });

  it('keeps windows whose mtime is within TTL', async () => {
    // Create a real activity marker with mtime set to 1 minute ago.
    touchActivity('h1', '%5');
    const p = activityPath('h1', '%5');
    const freshTime = new Date(Date.now() - 1 * 60 * 1000);
    fs.utimesSync(p, freshTime, freshTime);

    // list-windows returns the mirror
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct5') as never);

    const killed = await cleanupStaleMirrors({ ttlMs: 30 * 60 * 1000 });
    expect(killed).toEqual([]);
    // kill-window must NOT have been called
    const killCalls = (mockExeca as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => Array.isArray(c) && c[1] !== undefined && (c[1] as string[]).includes('kill-window'),
    );
    expect(killCalls).toHaveLength(0);
  });

  it('skips windows with no activity marker (conservative policy)', async () => {
    // No touchActivity call — marker does not exist.
    mockExeca.mockResolvedValueOnce(ok('mirror-h1-pct5') as never);

    const killed = await cleanupStaleMirrors({ ttlMs: 30 * 60 * 1000 });
    expect(killed).toEqual([]);
    const killCalls = (mockExeca as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => Array.isArray(c) && c[1] !== undefined && (c[1] as string[]).includes('kill-window'),
    );
    expect(killCalls).toHaveLength(0);
  });
});
