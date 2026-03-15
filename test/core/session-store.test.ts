import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, type Session } from '../../src/core/session-store.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 12345,
    sessionId: 'session-abc-123',
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
    store.register(makeSession({ sessionId: 'a', pid: 1 }));
    store.register(makeSession({ sessionId: 'b', pid: 2 }));
    expect(store.getAll()).toHaveLength(2);
  });

  it('getByPid finds session by PID', () => {
    const session = makeSession({ pid: 99 });
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
});
