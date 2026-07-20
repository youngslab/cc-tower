import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, type Session } from '../../src/core/session-store.js';
import type { ScannedSession } from '../../src/core/session-scanner.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1, sessionId: 'active-x', paneId: 'pane-x', hasTmux: false, detectionMode: 'hook',
    cwd: '/home/me/x', projectName: 'x', status: 'idle', lastActivity: new Date(),
    startedAt: new Date(), messageCount: 0, toolCallCount: 0, ...overrides,
  };
}

const scan = (sessionId: string, cwd: string, startedAt: number): ScannedSession => ({ sessionId, cwd, startedAt });

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'resumable-'));
  store = new SessionStore(join(tmpDir, 'state.json'));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

// Recent so restore()'s 30-day TTL eviction keeps the fixture entries.
const RECENT = Date.now() - 60_000;

/** Write a state.json fixture and restore it into persistedMeta. */
function withPersisted(sessions: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ version: 3, sessions }));
  store.restore();
}

describe('getAllResumableSessions', () => {
  it('returns all scanned sessions, sorted most-recent-first', () => {
    const out = store.getAllResumableSessions([
      scan('a', '/p/a', 100),
      scan('b', '/p/b', 300),
      scan('c', '/p/c', 200),
    ]);
    expect(out.map(s => s.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('excludes currently-active sessions', () => {
    store.register(makeSession({ sessionId: 'a', paneId: 'pane-a' }));
    const out = store.getAllResumableSessions([scan('a', '/p/a', 1), scan('b', '/p/b', 2)]);
    expect(out.map(s => s.sessionId)).toEqual(['b']);
  });

  it('uses the scanned customTitle (/rename) as the label', () => {
    const out = store.getAllResumableSessions([{ sessionId: 'a', cwd: '/p/a', startedAt: 1, customTitle: 'renamed' }]);
    expect(out[0]).toMatchObject({ sessionId: 'a', label: 'renamed' });
  });

  it('scanned customTitle wins over a persisted state.json label', () => {
    // A persisted label can be a stale fallback cached before the real /rename
    // was successfully read (e.g. a late /rename past the scanner's old
    // head-only read window) — the freshly scanned customTitle must win.
    withPersisted({ a: { cwd: '/p/a', startedAt: RECENT, label: 'statelabel' } });
    const out = store.getAllResumableSessions([{ sessionId: 'a', cwd: '/p/a', startedAt: 1, customTitle: 'renamed' }]);
    expect(out[0]!.label).toBe('renamed');
  });

  it('falls back to the persisted state.json label when there is no scanned customTitle', () => {
    withPersisted({ a: { cwd: '/p/a', startedAt: RECENT, label: 'statelabel' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 1)]);
    expect(out[0]!.label).toBe('statelabel');
  });

  it('state.json metadata wins for summary on a scanned session', () => {
    withPersisted({ a: { cwd: '/p/a', startedAt: RECENT, label: 'mylabel', goalSummary: 'the goal' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)]);
    expect(out[0]).toMatchObject({ sessionId: 'a', label: 'mylabel', goalSummary: 'the goal' });
  });

  it('includes persisted-only sessions not on disk (e.g. remote)', () => {
    withPersisted({ r: { cwd: '/remote/p', startedAt: RECENT, label: 'remoteproj', sshTarget: 'me@host' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)]);
    const remote = out.find(s => s.sessionId === 'r');
    expect(remote).toMatchObject({ cwd: '/remote/p', sshTarget: 'me@host', label: 'remoteproj' });
  });

  it('keeps the scanned cwd/startedAt as the disk source of truth', () => {
    withPersisted({ a: { cwd: '/stale/path', startedAt: RECENT, label: 'L' } });
    const out = store.getAllResumableSessions([scan('a', '/fresh/disk', 999)]);
    expect(out[0]).toMatchObject({ cwd: '/fresh/disk', startedAt: 999, label: 'L' });
  });

  it('drops persisted entries that have no cwd anywhere', () => {
    withPersisted({ nocwd: { startedAt: RECENT, label: 'L' } });
    const out = store.getAllResumableSessions([]);
    expect(out).toHaveLength(0);
  });

  it('scanComplete omitted: still includes a local persisted-only entry absent from scanned', () => {
    withPersisted({ local: { cwd: '/p/local', startedAt: RECENT, label: 'L' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)]);
    expect(out.map(s => s.sessionId)).toContain('local');
  });

  it('scanComplete=true: excludes a local persisted-only entry absent from scanned', () => {
    withPersisted({ local: { cwd: '/p/local', startedAt: RECENT, label: 'L' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)], true);
    expect(out.map(s => s.sessionId)).not.toContain('local');
  });

  it('scanComplete=true: still includes a persisted-only remote entry (sshTarget set) absent from scanned', () => {
    withPersisted({ r: { cwd: '/remote/p', startedAt: RECENT, label: 'remoteproj', sshTarget: 'me@host' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)], true);
    const remote = out.find(s => s.sessionId === 'r');
    expect(remote).toMatchObject({ cwd: '/remote/p', sshTarget: 'me@host', label: 'remoteproj' });
  });

  it('scanComplete=true: includes an entry whose sessionId is present in scanned', () => {
    withPersisted({ a: { cwd: '/p/a', startedAt: RECENT, label: 'L' } });
    const out = store.getAllResumableSessions([scan('a', '/p/a', 100)], true);
    expect(out.map(s => s.sessionId)).toContain('a');
  });
});
