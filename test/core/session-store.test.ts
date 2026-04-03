import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, sessionIdentity, type Session } from '../../src/core/session-store.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 12345,
    sessionId: 'session-abc-123',
    paneId: 'session-abc-123', // identity = paneId so store.get('session-abc-123') works
    hasTmux: false,
    detectionMode: 'hook',
    cwd: '/home/user/project',
    projectName: 'my-project',
    status: 'idle',
    lastActivity: new Date(),
    startedAt: new Date(),
    messageCount: 0,
    toolCallCount: 0,
    ...overrides,
  };
}

describe('SessionStore', () => {
  let tmpDir: string;
  let persistPath: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cc-tower-store-'));
    persistPath = join(tmpDir, 'state.json');
    store = new SessionStore(persistPath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- register / get / getAll / getByPid ---

  it('getAll returns empty array initially', () => {
    expect(store.getAll()).toEqual([]);
  });

  it('register adds a session and get retrieves it', () => {
    const session = makeSession();
    store.register(session);
    expect(store.get('session-abc-123')).toBe(session);
  });

  it('getAll returns all registered sessions', () => {
    store.register(makeSession({ sessionId: 'a', pid: 1, paneId: 'pane-a' }));
    store.register(makeSession({ sessionId: 'b', pid: 2, paneId: 'pane-b' }));
    expect(store.getAll()).toHaveLength(2);
  });

  it('getByPid finds session by PID', () => {
    const session = makeSession({ pid: 99, paneId: 'pane-99' });
    store.register(session);
    expect(store.getByPid(99)).toBe(session);
  });

  it('getByPid returns undefined for unknown PID', () => {
    expect(store.getByPid(99999)).toBeUndefined();
  });

  it('get returns undefined for unknown sessionId', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  // --- unregister ---

  it('unregister removes a session', () => {
    store.register(makeSession());
    store.unregister('session-abc-123');
    expect(store.get('session-abc-123')).toBeUndefined();
    expect(store.getAll()).toHaveLength(0);
  });

  it('unregister does nothing for unknown sessionId', () => {
    expect(() => store.unregister('nope')).not.toThrow();
  });

  // --- update ---

  it('update merges patch into session', () => {
    store.register(makeSession());
    store.update('session-abc-123', { status: 'thinking', messageCount: 5 });
    const updated = store.get('session-abc-123');
    expect(updated?.status).toBe('thinking');
    expect(updated?.messageCount).toBe(5);
  });

  it('update does not throw for unknown sessionId', () => {
    expect(() => store.update('ghost', { status: 'dead' })).not.toThrow();
  });

  // --- events ---

  it('register emits session-added', () => {
    const events: Session[] = [];
    store.on('session-added', (s: Session) => events.push(s));
    store.register(makeSession());
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe('session-abc-123');
  });

  it('unregister emits session-removed', () => {
    const events: Session[] = [];
    store.on('session-removed', (s: Session) => events.push(s));
    store.register(makeSession());
    store.unregister('session-abc-123');
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe('session-abc-123');
  });

  it('update emits session-updated', () => {
    const events: Session[] = [];
    store.on('session-updated', (s: Session) => events.push(s));
    store.register(makeSession());
    store.update('session-abc-123', { status: 'executing' });
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('executing');
  });

  // --- persist / restore ---

  it('persist writes label and tags to disk after debounce', async () => {
    store.register(makeSession({ label: 'my-label', tags: ['backend', 'api'] }));
    store.persist();

    // Wait for 2s debounce + buffer
    await new Promise((r) => setTimeout(r, 2500));

    const raw = await readFile(persistPath, 'utf8');
    const data = JSON.parse(raw) as { sessions: Record<string, { label?: string; tags?: string[] }> };
    expect(data.sessions['session-abc-123']?.label).toBe('my-label');
    expect(data.sessions['session-abc-123']?.tags).toEqual(['backend', 'api']);
  }, 10000);

  it('restore merges label/tags back into registered sessions', async () => {
    // Write a state file
    const stateData = {
      sessions: {
        'session-abc-123': { label: 'restored-label', tags: ['frontend'] },
      },
    };
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, JSON.stringify(stateData), 'utf8');

    // Register session then restore
    store.register(makeSession());
    store.restore();

    // Wait for async restore to complete
    await new Promise((r) => setTimeout(r, 100));

    const session = store.get('session-abc-123');
    expect(session?.label).toBe('restored-label');
    expect(session?.tags).toEqual(['frontend']);
  });

  it('restore does not crash when file is missing', async () => {
    store.register(makeSession());
    expect(() => store.restore()).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    // session should be unaffected
    expect(store.get('session-abc-123')?.label).toBeUndefined();
  });

  it('persist/restore round-trip preserves metadata', async () => {
    store.register(makeSession({ label: 'round-trip', tags: ['test'] }));
    store.persist();
    await new Promise((r) => setTimeout(r, 2500));

    // Create a new store, register same session, then restore
    const store2 = new SessionStore(persistPath);
    store2.register(makeSession({ sessionId: 'session-abc-123', pid: 12345 }));
    store2.restore();
    await new Promise((r) => setTimeout(r, 100));

    expect(store2.get('session-abc-123')?.label).toBe('round-trip');
    expect(store2.get('session-abc-123')?.tags).toEqual(['test']);
  }, 10000);

  // --- sessionIdentity helper ---

  it('sessionIdentity returns paneId when present', () => {
    expect(sessionIdentity({ paneId: '%7', pid: 100 })).toBe('%7');
  });

  it('sessionIdentity returns String(pid) when paneId absent', () => {
    expect(sessionIdentity({ paneId: undefined, pid: 100 })).toBe('100');
  });

  // --- identity-based keying ---

  it('register keys session by paneId when present', () => {
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'uuid-A' });
    store.register(session);
    expect(store.get('%7')).toBe(session);
    expect(store.get('100')).toBeUndefined();
  });

  it('register keys session by String(pid) when paneId absent', () => {
    const session = makeSession({ paneId: undefined, pid: 200, sessionId: 'uuid-B' });
    store.register(session);
    expect(store.get('200')).toBe(session);
  });

  it('getBySessionId finds session by sessionId field', () => {
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'uuid-X' });
    store.register(session);
    expect(store.getBySessionId('uuid-X')).toBe(session);
    expect(store.getBySessionId('nonexistent')).toBeUndefined();
  });

  // --- rekey ---

  it('rekey moves session to new identity without data loss', () => {
    const session = makeSession({ paneId: undefined, pid: 100, sessionId: 'uuid-C', label: 'my-label' });
    store.register(session);
    expect(store.get('100')).toBe(session);

    store.rekey('100', '%9');
    expect(store.get('100')).toBeUndefined();
    expect(store.get('%9')).toBe(session);
    expect(store.get('%9')?.label).toBe('my-label');
  });

  it('rekey is a no-op when old and new identity are the same', () => {
    const session = makeSession({ paneId: '%7', pid: 100 });
    store.register(session);
    store.rekey('%7', '%7');
    expect(store.get('%7')).toBe(session);
  });

  it('rekey emits session-rekeyed event', () => {
    const events: Array<{ oldIdentity: string; newIdentity: string }> = [];
    store.on('session-rekeyed', (e) => events.push(e));
    const session = makeSession({ paneId: undefined, pid: 100 });
    store.register(session);
    store.rekey('100', '%5');
    expect(events).toHaveLength(1);
    expect(events[0]?.oldIdentity).toBe('100');
    expect(events[0]?.newIdentity).toBe('%5');
  });

  // --- metadata survives sessionId change (simulating /clear) ---

  it('updating sessionId in-place preserves label/tags/favorite', () => {
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'old-uuid', label: 'keep-me', tags: ['a'] });
    store.register(session);
    // /clear: same pane, new sessionId
    store.update('%7', { sessionId: 'new-uuid' });
    const updated = store.get('%7');
    expect(updated?.sessionId).toBe('new-uuid');
    expect(updated?.label).toBe('keep-me');
    expect(updated?.tags).toEqual(['a']);
  });

  // --- persistSync writes sessionId as key, not identity ---

  it('persistSync writes sessionId (not paneId) as state.json key', () => {
    const { writeFileSync } = require('node:fs');
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'uuid-persist', label: 'test' });
    store.register(session);
    store.persistSync();
    const raw = require('node:fs').readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.sessions['uuid-persist']).toBeDefined();
    expect(data.sessions['%7']).toBeUndefined();
    expect(data.version).toBe(2);
  });

  // --- state.json v2 TTL eviction ---

  it('restore evicts non-favorited entries older than 30 days (v2)', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const stateData = {
      version: 2,
      sessions: {
        'old-session': { label: 'stale', startedAt: thirtyOneDaysAgo, favorite: false },
        'recent-session': { label: 'fresh', startedAt: Date.now() - 1000, favorite: false },
        'old-favorited': { label: 'keep', startedAt: thirtyOneDaysAgo, favorite: true },
      },
    };
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, JSON.stringify(stateData), 'utf8');

    store.restore();
    await new Promise((r) => setTimeout(r, 100));

    expect(store.getPersistedEntry?.('old-session')).toBeUndefined(); // evicted
    expect(store.getPersistedEntry?.('recent-session')).toBeDefined(); // kept
    expect(store.getPersistedEntry?.('old-favorited')).toBeDefined(); // kept (favorited)
  });

  it('restore does NOT evict v1 entries (no version field) even if old', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const stateData = {
      // no version field = v1
      sessions: {
        'old-v1': { label: 'legacy', startedAt: thirtyOneDaysAgo },
      },
    };
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, JSON.stringify(stateData), 'utf8');

    store.restore();
    await new Promise((r) => setTimeout(r, 100));

    expect(store.getPersistedEntry?.('old-v1')).toBeDefined(); // NOT evicted (v1)
  });

  // --- getPastSessionsByCwd excludes active sessions by sessionId ---

  it('getPastSessionsByCwd excludes active sessions correctly', () => {
    // Active session with paneId as identity
    store.register(makeSession({ paneId: '%7', pid: 100, sessionId: 'active-uuid', cwd: '/proj' }));
    // Simulate persistedMeta having both active and past sessions
    // (restore normally populates persistedMeta — simulate by calling directly)
    (store as any).persistedMeta.set('active-uuid', { cwd: '/proj', startedAt: Date.now() - 1000, goalSummary: 'active' });
    (store as any).persistedMeta.set('past-uuid', { cwd: '/proj', startedAt: Date.now() - 5000, goalSummary: 'past' });

    const past = store.getPastSessionsByCwd('/proj');
    expect(past.map(p => p.sessionId)).not.toContain('active-uuid');
    expect(past.map(p => p.sessionId)).toContain('past-uuid');
  });
});
