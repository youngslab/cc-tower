import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier } from '../../src/core/notifier.js';
import { SessionStore, Session } from '../../src/core/session-store.js';
import { StateChange } from '../../src/core/state-machine.js';
import os from 'node:os';
import path from 'node:path';

// Mock node-notifier
vi.mock('node-notifier', () => ({
  default: { notify: vi.fn() },
}));

function makeStore(): SessionStore {
  return new SessionStore(path.join(os.tmpdir(), `notifier-test-${process.pid}.json`));
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1234,
    sessionId: 'test-session',
    hasTmux: true,
    detectionMode: 'hook',
    cwd: '/home/user/project',
    projectName: 'project',
    status: 'idle',
    lastActivity: new Date(),
    startedAt: new Date(),
    messageCount: 10,
    toolCallCount: 5,
    ...overrides,
  };
}

const defaultConfig = {
  enabled: true,
  min_duration: 30,
  cooldown: 30,
  suppress_when_focused: true,
  channels: { desktop: true, tmux_bell: true, sound: false },
  alerts: { on_error: true, on_cost_threshold: 5.0, on_session_death: true },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' },
};

describe('Notifier', () => {
  let store: SessionStore;
  let notifierInstance: Notifier;

  beforeEach(() => {
    store = makeStore();
    notifierInstance = new Notifier(defaultConfig, store);
    vi.clearAllMocks();
  });

  it('sends notification when turn >= 30s and not focused', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(false);

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 60000, // 60 seconds
    };

    notifierInstance.onStateChange(change);
    expect(events.length).toBe(1);
  });

  it('suppresses notification when turn < 30s', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(false);

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 5000, // 5 seconds - too short
    };

    notifierInstance.onStateChange(change);
    expect(events.length).toBe(0);
  });

  it('suppresses notification when dashboard is focused', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(true); // focused!

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 60000,
    };

    notifierInstance.onStateChange(change);
    expect(events.length).toBe(0);
  });

  it('respects cooldown between notifications', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(false);

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 60000,
    };

    notifierInstance.onStateChange(change);
    notifierInstance.onStateChange(change); // second call within cooldown
    expect(events.length).toBe(1); // only one notification
  });

  it('always sends session death notification', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(true); // even when focused

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'executing',
      to: 'dead',
      event: { type: 'session-end' },
      timestamp: Date.now(),
      duration: 1000, // short duration doesn't matter
    };

    notifierInstance.onStateChange(change);
    expect(events.length).toBe(1);
    expect(events[0].level).toBe('error');
  });

  it('suppresses when session is being peeked', () => {
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(false);
    notifierInstance.setPeeking('test-session');

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    const change: StateChange = {
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 60000,
    };

    notifierInstance.onStateChange(change);
    expect(events.length).toBe(0);
  });

  it('does nothing when notifications disabled', () => {
    store = makeStore();
    notifierInstance = new Notifier({ ...defaultConfig, enabled: false }, store);
    const session = makeSession();
    store.register(session);
    notifierInstance.setFocused(false);

    const events: any[] = [];
    notifierInstance.on('notification', (e) => events.push(e));

    notifierInstance.onStateChange({
      sessionId: 'test-session',
      from: 'thinking',
      to: 'idle',
      event: { type: 'stop' },
      timestamp: Date.now(),
      duration: 60000,
    });

    expect(events.length).toBe(0);
  });
});
