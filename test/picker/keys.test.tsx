/**
 * Picker keys — Tier 3 (in-process, ink-testing-library)
 *
 * Validates that key inputs in picker mode produce the correct JSON output.
 * `writeAndExit` is mocked to write the file without calling process.exit,
 * so the full React tree can be inspected in-process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import React from 'react';

// ── Mock writeAndExit BEFORE importing App (which imports protocol) ──────────
vi.mock('../../src/picker/protocol.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/picker/protocol.js')>(
    '../../src/picker/protocol.js',
  );
  return {
    ...actual,
    writeAndExit: vi.fn((outputPath: string, payload: unknown) => {
      // Write the file synchronously (same as the real impl), but DON'T exit.
      fs.writeFileSync(outputPath, JSON.stringify(payload) + '\n');
    }),
  };
});

// Import App AFTER mock is registered
import { App } from '../../src/ui/App.js';
import type { Session } from '../../src/core/session-store.js';
import { EventEmitter } from 'node:events';

// ── Minimal mock Tower ────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1234,
    paneId: '%5',
    sessionId: 'test-session-id',
    hasTmux: true,
    detectionMode: 'jsonl',
    cwd: '/home/test/project',
    projectName: 'project',
    status: 'idle',
    lastActivity: new Date(),
    startedAt: new Date(),
    messageCount: 3,
    toolCallCount: 1,
    host: 'local',
    sshTarget: undefined,
    ...overrides,
  } as Session;
}

function makeMockStore(sessions: Session[]) {
  const ee = new EventEmitter();
  return {
    getAll: () => sessions,
    on: (event: string, listener: (...args: unknown[]) => void) => { ee.on(event, listener); return () => ee.off(event, listener); },
    off: (event: string, listener: (...args: unknown[]) => void) => { ee.off(event, listener); },
    update: vi.fn(),
    displayOrder: [] as string[],
    getPastSessionsByCwd: () => [],
    getPastSessionsByTarget: () => [],
    getAllPastSessions: () => [],
    deletePersistedSession: vi.fn(),
  };
}

function makeMockTower(sessions: Session[] = [makeSession()]) {
  const store = makeMockStore(sessions);
  return {
    store,
    config: {
      keys: { close: 'Ctrl-d' },
      hosts: [],
      commands: { confirm_when_busy: false },
      claude_args: undefined,
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('../../src/core/tower.js').Tower;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Wait a few event-loop ticks for React effects to settle. */
const settle = (ms = 150) => new Promise<void>(r => setTimeout(r, ms));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('picker keys (ink-testing-library)', () => {
  let tmpdir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-keys-'));
    outputPath = path.join(tmpdir, 'out.json');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  // ── Test 1: Enter → action: 'go' ──────────────────────────────────────────
  it('Enter on selected session writes go JSON with correct paneId', async () => {
    const session = makeSession({ paneId: '%5', sessionId: 'abc-123' });
    const tower = makeMockTower([session]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('\r'); // Enter
    await settle();

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('go');
    expect(result.paneId).toBe('%5');
    expect(result.sessionId).toBe('abc-123');

    unmount();
  });

  // ── Test 2: '/' → SendInput view, text → Enter → action: 'send' ──────────
  it('/ opens SendInput and Enter submits send JSON', async () => {
    const session = makeSession({ paneId: '%7', sessionId: 'send-sess' });
    const tower = makeMockTower([session]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('/'); // open SendInput for highlighted session
    await settle();
    stdin.write('hello world'); // type message
    await settle();
    stdin.write('\r'); // submit
    await settle(200);

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('send');
    expect(result.text).toBe('hello world');
    expect(result.paneId).toBe('%7');

    unmount();
  });

  // ── Test 3: 'n' → NewSession view → ESC → action: 'cancel' ───────────────
  it('n opens NewSession; ESC from NewSession writes cancel JSON', async () => {
    const tower = makeMockTower([makeSession()]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('n'); // open new session
    await settle();
    stdin.write('\x1b'); // ESC → cancel
    await settle(200);

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('cancel');

    unmount();
  });

  // ── Test 4: 'q' → confirmQuit → 'y' → action: 'cancel' ───────────────────
  it('q → y (confirm quit) writes cancel JSON', async () => {
    const tower = makeMockTower([makeSession()]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('q'); // quit key
    await settle();
    stdin.write('y'); // confirm
    await settle(200);

    // In picker mode, quit calls writeAndExit({ action: 'cancel' })
    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('cancel');

    unmount();
  });

  // ── Test 5: ESC in SendInput → action: 'cancel' ───────────────────────────
  it('ESC in SendInput view writes cancel JSON', async () => {
    const session = makeSession({ paneId: '%9' });
    const tower = makeMockTower([session]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('/'); // open SendInput
    await settle();
    stdin.write('\x1b'); // ESC → cancel from SendInput
    await settle(200);

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('cancel');

    unmount();
  });
});
