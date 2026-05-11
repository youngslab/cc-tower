import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock all Tower dependencies so we can construct one cheaply
vi.mock('../../src/core/discovery.js', () => ({
  DiscoveryEngine: class {
    on() {}
    start() {}
    scanOnce() { return Promise.resolve([]); }
  },
}));
vi.mock('../../src/core/hook-receiver.js', () => ({
  HookReceiver: class {
    on() {}
    start() { return Promise.resolve(); }
    stop() {}
  },
}));
vi.mock('../../src/core/jsonl-watcher.js', () => ({
  JsonlWatcher: class { on() {} watch() {} unwatch() {} stop() {} },
}));
vi.mock('../../src/core/process-monitor.js', () => ({
  ProcessMonitor: class { on() {} start() {} stop() {} },
}));
vi.mock('../../src/core/summarizer.js', () => ({
  Summarizer: class { on() {} stop() {} },
}));
vi.mock('../../src/core/notifier.js', () => ({
  Notifier: class { on() {} notify() {} },
}));
vi.mock('../../src/ssh/connection-manager.js', () => ({
  ConnectionManager: class { startTunnel() { return Promise.resolve(false); } stop() {} },
}));
vi.mock('../../src/ssh/remote-discovery.js', () => ({
  RemoteDiscovery: class { on() {} start() {} stop() {} },
}));
vi.mock('../../src/agents/registry.js', () => ({
  agents: { claude: { startLlmSession() {}, isHeadlessSession() { return false; }, clearSummaryCache() {} } },
}));

import { Tower } from '../../src/core/tower.js';
import { SessionStore } from '../../src/core/session-store.js';

function makeTower(tmpDir: string): Tower {
  const persistPath = join(tmpDir, 'state.json');
  const tower = new Tower(
    {
      discovery: { scan_interval: 60000, claude_dir: tmpDir },
      notifications: { enabled: false, bell: false },
      hosts: [],
    } as any,
    { readOnly: true, skipSummary: true }
  );
  // Swap store to use tmpDir persist path
  (tower as any).store = new SessionStore(persistPath);
  return tower;
}

describe('applyQueuedEvent — session-start upsert', () => {
  let tmpDir: string;
  let tower: Tower;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popmux-drain-'));
    tower = makeTower(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers new session when pane is live', () => {
    const livePanes = new Set(['%5']);
    const event = {
      v: 1,
      event: 'session-start',
      sid: 'new-sid-001',
      cwd: '/home/user/myproject',
      pane: '%5',
      pid: 9999,
      ts: Date.now(),
    };

    (tower as any).applyQueuedEvent(event, livePanes);

    const sessions = (tower as any).store.getAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('new-sid-001');
    expect(sessions[0].paneId).toBe('%5');
    expect(sessions[0].cwd).toBe('/home/user/myproject');
    expect(sessions[0].projectName).toBe('myproject');
    expect(sessions[0].status).toBe('idle');
    expect(sessions[0].detectionMode).toBe('hook');
  });

  it('drops session-start when pane is dead (not in livePanes)', () => {
    const livePanes = new Set<string>(); // empty — pane %5 not alive
    const event = {
      v: 1,
      event: 'session-start',
      sid: 'new-sid-002',
      cwd: '/home/user/project',
      pane: '%5',
      pid: 9998,
      ts: Date.now(),
    };

    (tower as any).applyQueuedEvent(event, livePanes);

    expect((tower as any).store.getAll()).toHaveLength(0);
  });

  it('drops session-start when payload is missing cwd', () => {
    const livePanes = new Set(['%7']);
    const event = {
      v: 1,
      event: 'session-start',
      sid: 'new-sid-003',
      // cwd missing
      pane: '%7',
      pid: 9997,
      ts: Date.now(),
    };

    (tower as any).applyQueuedEvent(event, livePanes);

    expect((tower as any).store.getAll()).toHaveLength(0);
  });

  it('updates status only when session already exists (no duplicate register)', () => {
    const livePanes = new Set(['%9']);
    const store: SessionStore = (tower as any).store;

    // Pre-register the session
    store.register({
      pid: 1111,
      paneId: '%9',
      sessionId: 'existing-sid',
      hasTmux: true,
      detectionMode: 'hook',
      cwd: '/home/user/existing',
      projectName: 'existing',
      status: 'thinking',
      lastActivity: new Date(),
      startedAt: new Date(),
      messageCount: 0,
      toolCallCount: 0,
      host: 'local',
    });

    const event = {
      v: 1,
      event: 'session-start',
      sid: 'existing-sid',
      cwd: '/home/user/existing',
      pane: '%9',
      pid: 1111,
      ts: Date.now(),
    };

    (tower as any).applyQueuedEvent(event, livePanes);

    const sessions = store.getAll();
    expect(sessions).toHaveLength(1); // no duplicate
    expect(sessions[0].status).toBe('idle'); // updated from thinking → idle
  });
});
