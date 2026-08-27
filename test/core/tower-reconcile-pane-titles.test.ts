import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock all Tower dependencies so we can construct one cheaply — same pattern
// as tower-drain-session-start.test.ts.
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
import { SessionStore, Session } from '../../src/core/session-store.js';

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
  (tower as any).store = new SessionStore(persistPath);
  return tower;
}

// Older than Tower's PANE_TITLE_OVERRIDE_GRACE_MS (30s) — simulates "hooks
// have been silent for a while, the title is our only signal now".
const STALE_ACTIVITY = new Date(Date.now() - 60000);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1,
    sessionId: 'sid-1',
    paneId: '%7',
    hasTmux: true,
    detectionMode: 'jsonl',
    cwd: '/home/user/project',
    projectName: 'project',
    status: 'idle',
    lastActivity: STALE_ACTIVITY,
    startedAt: new Date(),
    messageCount: 0,
    toolCallCount: 0,
    ...overrides,
  };
}

// Regression: hook-derived status (drainEventQueue) can get stuck wrong
// indefinitely if a hook is lost, misordered, or uses an unrecognized event
// name — with no self-healing. The tmux pane title is ground truth set
// directly by Claude Code, so reconciling against it every drain tick fixes
// staleness in either direction.
describe('Tower.applyPaneTitles (pane-title reconciliation)', () => {
  let tmpDir: string;
  let tower: Tower;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'popmux-reconcile-'));
    tower = makeTower(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downgrades a session stuck on a running status to idle when the pane title shows the fixed idle glyph', () => {
    tower.store.register(makeSession({ status: 'thinking' }));
    (tower as any).applyPaneTitles(new Map([['%7', '✳ manager']]));
    expect(tower.store.get('%7')?.status).toBe('idle');
  });

  it('upgrades a session stuck on idle to thinking when the pane title shows a busy spinner glyph', () => {
    tower.store.register(makeSession({ status: 'idle' }));
    (tower as any).applyPaneTitles(new Map([['%7', '◐ interview']]));
    expect(tower.store.get('%7')?.status).toBe('thinking');
  });

  it('sets needsAttention when the pane title reveals a running→idle transition hooks missed', () => {
    tower.store.register(makeSession({ status: 'executing' }));
    (tower as any).applyPaneTitles(new Map([['%7', '✳ manager']]));
    expect(tower.store.get('%7')?.needsAttention).toBe(true);
  });

  // Regression: Claude Code doesn't repaint the pane title while delegating
  // to a subagent ("← 1 agent") — it stays stuck on the fixed idle glyph even
  // though hooks correctly report real activity. Reproduced live: a hook
  // event applied on one drain tick was immediately undone by pane-title
  // reconciliation in that same tick, because the (stuck) title still said
  // idle. Recently-confirmed activity must win over a title glyph.
  it('does not downgrade busy→idle when a hook confirmed activity very recently, even if the title glyph says idle', () => {
    tower.store.register(makeSession({ status: 'thinking', lastActivity: new Date() }));
    (tower as any).applyPaneTitles(new Map([['%7', '✳ ccu2-mp-image-validation']]));
    expect(tower.store.get('%7')?.status).toBe('thinking');
  });

  it('leaves status untouched when the title has no recognized Claude Code glyph', () => {
    tower.store.register(makeSession({ status: 'thinking' }));
    (tower as any).applyPaneTitles(new Map([['%7', 'kevin.park@host:~']]));
    expect(tower.store.get('%7')?.status).toBe('thinking');
  });

  it('leaves status untouched when the pane is not found in the titles map (e.g. remote mirror)', () => {
    tower.store.register(makeSession({ status: 'executing' }));
    (tower as any).applyPaneTitles(new Map());
    expect(tower.store.get('%7')?.status).toBe('executing');
  });

  it('never resurrects a dead session', () => {
    tower.store.register(makeSession({ status: 'dead' }));
    (tower as any).applyPaneTitles(new Map([['%7', '◐ manager']]));
    expect(tower.store.get('%7')?.status).toBe('dead');
  });
});
