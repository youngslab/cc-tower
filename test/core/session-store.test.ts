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
    tmpDir = await mkdtemp(join(tmpdir(), 'popmux-store-'));
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
    expect(store.get('session-abc-123')).toStrictEqual(session);
  });

  it('getAll returns all registered sessions', () => {
    store.register(makeSession({ sessionId: 'a', pid: 1, paneId: 'pane-a' }));
    store.register(makeSession({ sessionId: 'b', pid: 2, paneId: 'pane-b' }));
    expect(store.getAll()).toHaveLength(2);
  });

  it('getByPid finds session by PID', () => {
    const session = makeSession({ pid: 99, paneId: 'pane-99' });
    store.register(session);
    expect(store.getByPid(99)).toStrictEqual(session);
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

    // restore() must be called BEFORE register() so persistedMeta is populated
    // when register() merges it into sessionMeta
    store.restore();
    store.register(makeSession());

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

    // Create a new store: restore() first (populates persistedMeta), then register
    const store2 = new SessionStore(persistPath);
    store2.restore();
    store2.register(makeSession({ sessionId: 'session-abc-123', pid: 12345 }));
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
    expect(store.get('%7')).toStrictEqual(session);
    expect(store.get('100')).toBeUndefined();
  });

  it('register keys session by String(pid) when paneId absent', () => {
    const session = makeSession({ paneId: undefined, pid: 200, sessionId: 'uuid-B' });
    store.register(session);
    expect(store.get('200')).toStrictEqual(session);
  });

  it('getBySessionId finds session by sessionId field', () => {
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'uuid-X' });
    store.register(session);
    expect(store.getBySessionId('uuid-X')).toStrictEqual(session);
    expect(store.getBySessionId('nonexistent')).toBeUndefined();
  });

  // --- rekey ---

  it('rekey moves session to new identity without data loss', () => {
    const session = makeSession({ paneId: undefined, pid: 100, sessionId: 'uuid-C', label: 'my-label' });
    store.register(session);
    expect(store.get('100')).toStrictEqual(session);

    store.rekey('100', '%9');
    expect(store.get('100')).toBeUndefined();
    expect(store.get('%9')).toStrictEqual(session);
    expect(store.get('%9')?.label).toBe('my-label');
  });

  it('rekey is a no-op when old and new identity are the same', () => {
    const session = makeSession({ paneId: '%7', pid: 100 });
    store.register(session);
    store.rekey('%7', '%7');
    expect(store.get('%7')).toStrictEqual(session);
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

  it('updating sessionId in-place (/clear): new sessionId gets clean metadata', () => {
    const session = makeSession({ paneId: '%7', pid: 100, sessionId: 'old-uuid', label: 'keep-me', tags: ['a'] });
    store.register(session);
    // /clear: same pane, new sessionId — meta stays under old-uuid, new-uuid starts clean
    store.update('%7', { sessionId: 'new-uuid' });
    const updated = store.get('%7');
    expect(updated?.sessionId).toBe('new-uuid');
    expect(updated?.label).toBeUndefined();
    expect(updated?.tags).toBeUndefined();
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
    expect(data.version).toBe(3);
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

  // --- Instance/Session separation ---

  it('register() does not auto-merge metadata from persistedMeta for NEW sessionIds', () => {
    // Register a session with a brand new sessionId not in any persisted state
    const session = makeSession({ sessionId: 'brand-new-uuid', paneId: '%7', label: undefined, tags: undefined });
    store.register(session);
    const s = store.get('%7');
    expect(s?.label).toBeUndefined();
    expect(s?.tags).toBeUndefined();
    expect(s?.goalSummary).toBeUndefined();
  });

  it('getAll() returns merged Instance + SessionMeta', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'uuid-merge' }));
    store.updateMeta('%7', { label: 'merged-label', goalSummary: 'goal' });
    const all = store.getAll();
    expect(all[0]?.label).toBe('merged-label');
    expect(all[0]?.goalSummary).toBe('goal');
    expect(all[0]?.pid).toBe(12345); // runtime field still present
  });

  it('unregister() removes instance but preserves sessionMeta', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'uuid-unreg' }));
    store.updateMeta('%7', { label: 'keep-me' });
    store.unregister('%7');
    // Instance gone
    expect(store.get('%7')).toBeUndefined();
    // But if we register again with same sessionId, meta comes back
    store.register(makeSession({ paneId: '%7', sessionId: 'uuid-unreg' }));
    expect(store.get('%7')?.label).toBe('keep-me');
  });

  it('/clear scenario: new sessionId gets clean metadata', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'old-uuid' }));
    store.updateMeta('%7', { label: 'old-label', goalSummary: 'old-goal' });
    // Simulate /clear: update to new sessionId — NO reassociateMeta, clean start
    store.update('%7', { sessionId: 'new-uuid' });
    const s = store.get('%7');
    expect(s?.sessionId).toBe('new-uuid');
    expect(s?.label).toBeUndefined();
    expect(s?.goalSummary).toBeUndefined();
    // old sessionId meta is still in sessionMeta (archived)
    expect((store as any).sessionMeta.has('old-uuid')).toBe(true);
  });

  it('update() with mixed patch splits meta vs runtime fields correctly', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'uuid-mixed' }));
    // Mixed patch: label (meta) + messageCount (runtime)
    store.update('%7', { label: 'mixed-label', messageCount: 42 } as any);
    const s = store.get('%7');
    expect(s?.label).toBe('mixed-label');
    expect(s?.messageCount).toBe(42);
  });

  it('updateMeta() routes to sessionMeta and is accessible via getAll()', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'uuid-updatemeta' }));
    store.updateMeta('%7', { label: 'meta-only', tags: ['x'] });
    expect(store.get('%7')?.label).toBe('meta-only');
    expect(store.get('%7')?.tags).toEqual(['x']);
    expect(store.get('%7')?.pid).toBe(12345); // runtime field unaffected
  });

  it('reassociateMeta() moves meta from old to new sessionId', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'old-sid' }));
    store.updateMeta('%7', { label: 'move-me', goalSummary: 'move-goal' });
    store.reassociateMeta('old-sid', 'new-sid');
    store.update('%7', { sessionId: 'new-sid' });
    const s = store.get('%7');
    expect(s?.sessionId).toBe('new-sid');
    expect(s?.label).toBe('move-me');
    expect(s?.goalSummary).toBe('move-goal');
  });

  it('reassociateMeta() no-ops when old sessionId has no meta', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'no-meta-sid' }));
    // Should not throw
    expect(() => store.reassociateMeta('no-meta-sid', 'other-sid')).not.toThrow();
    // Instance still accessible
    expect(store.get('%7')).toBeDefined();
  });

  it('rekey() does not affect sessionMeta', () => {
    store.register(makeSession({ paneId: undefined, pid: 100, sessionId: 'uuid-rekey' }));
    store.updateMeta('100', { label: 'rekey-label' });
    store.rekey('100', '%9');
    // SessionMeta still accessible via new identity (same sessionId)
    expect(store.get('%9')?.label).toBe('rekey-label');
    expect(store.get('%9')?.sessionId).toBe('uuid-rekey');
  });

  it('/resume scenario: update() with new sessionId preserves metadata via reassociateMeta', () => {
    store.register(makeSession({ paneId: '%7', sessionId: 'resume-old' }));
    store.updateMeta('%7', { label: 'resume-label', goalSummary: 'resume-goal' });
    // Simulate /resume: tower.ts calls reassociateMeta() THEN updates sessionId
    store.reassociateMeta('resume-old', 'resume-new');
    store.update('%7', { sessionId: 'resume-new' });
    const s = store.get('%7');
    expect(s?.sessionId).toBe('resume-new');
    expect(s?.label).toBe('resume-label');
    expect(s?.goalSummary).toBe('resume-goal');
  });

  it('persist cycle preserves historical (non-live) sessions', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    // Pre-populate state with a historical session
    const historical = { 'historical-uuid': { label: 'historical', tags: ['old'], cwd: '/old', startedAt: Date.now() - 1000, goalSummary: 'old-goal' } };
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, JSON.stringify({ version: 2, sessions: historical }), 'utf8');

    // New store: restore, register a NEW session, persist
    const store2 = new SessionStore(persistPath);
    store2.restore();
    await new Promise(r => setTimeout(r, 100));
    store2.register(makeSession({ sessionId: 'live-uuid', paneId: '%5' }));
    store2.persistSync();

    // Historical session must still be in state.json
    const raw = require('node:fs').readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.sessions['historical-uuid']).toBeDefined();
    expect(data.sessions['historical-uuid'].label).toBe('historical');
  });

  it('persist duplicate resolution: live sessionMeta wins over persistedMeta', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    // Pre-populate state with old data for a sessionId
    const old = { 'shared-uuid': { label: 'old-label', cwd: '/proj', startedAt: Date.now() - 1000 } };
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, JSON.stringify({ version: 2, sessions: old }), 'utf8');

    const store2 = new SessionStore(persistPath);
    store2.restore();
    await new Promise(r => setTimeout(r, 100));
    // Register a live session with the SAME sessionId but different label
    store2.register(makeSession({ sessionId: 'shared-uuid', paneId: '%5' }));
    store2.updateMeta('%5', { label: 'live-label' });
    store2.persistSync();

    const raw = require('node:fs').readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    // Live label wins over old persisted label
    expect(data.sessions['shared-uuid'].label).toBe('live-label');
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
