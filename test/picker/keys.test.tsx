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

type PastEntry = { sessionId: string; cwd: string; startedAt: number; label?: string; sshTarget?: string };

function makeMockStore(sessions: Session[], pastSessions: PastEntry[] = []) {
  const ee = new EventEmitter();
  return {
    getAll: () => sessions,
    on: (event: string, listener: (...args: unknown[]) => void) => { ee.on(event, listener); return () => ee.off(event, listener); },
    off: (event: string, listener: (...args: unknown[]) => void) => { ee.off(event, listener); },
    update: vi.fn(),
    displayOrder: [] as string[],
    getPastSessionsByCwd: () => [],
    getPastSessionsByTarget: (sshTarget?: string) =>
      pastSessions.filter(p => (sshTarget ? p.sshTarget === sshTarget : !p.sshTarget)),
    getAllPastSessions: () => pastSessions,
    getAllResumableSessions: (_scanned: unknown) => pastSessions,
    deletePersistedSession: vi.fn(),
  };
}

function makeMockTower(sessions: Session[] = [makeSession()], pastSessions: PastEntry[] = []) {
  const store = makeMockStore(sessions, pastSessions);
  return {
    store,
    scanner: {
      isScanned: () => true,
      ensureScanned: () => Promise.resolve(),
      getCached: () => [],
    },
    config: {
      keys: { close: 'Ctrl-d' },
      hosts: [],
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

  // ── Test 1b: 'g' on dashboard → action: 'go' (B2 explicit) ───────────────
  it("'g' on highlighted session writes go JSON directly from dashboard", async () => {
    const session = makeSession({ paneId: '%9', sessionId: 'go-key', host: 'local' });
    const tower = makeMockTower([session]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('g');
    await settle();

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('go');
    expect(result.paneId).toBe('%9');
    expect(result.sessionId).toBe('go-key');
    expect(result.host).toBe('local');

    unmount();
  });

  // ── Test 2: '/' → fuzzy search → select moves cursor → Enter → go ─────────
  it('/ opens search; selecting a named session moves the cursor there', async () => {
    const alpha = makeSession({ paneId: '%5', sessionId: 's-alpha', label: 'alpha' });
    const beta = makeSession({ paneId: '%7', sessionId: 's-beta', label: 'beta' });
    const tower = makeMockTower([alpha, beta]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('/'); // open search overlay
    await settle();
    stdin.write('beta'); // filter to the second session
    await settle();
    stdin.write('\r'); // select → cursor moves to beta, overlay closes (no JSON yet)
    await settle();
    expect(fs.existsSync(outputPath)).toBe(false); // selecting in search never writes JSON

    stdin.write('\r'); // dashboard Enter → go on the now-highlighted session
    await settle(200);

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('go');
    expect(result.sessionId).toBe('s-beta');
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

  // ── Test 3b: 'n' shows workspace cwd rows, no resume/recent/summary text ──
  it('n opens NewSession showing workspace cwd rows without resume/recent/summary text', async () => {
    const localPast = { sessionId: 'past-local', cwd: '/home/me/workspace-alpha', startedAt: 1, label: 'alpha' };
    const tower = makeMockTower([makeSession()], [localPast]);

    const { stdin, lastFrame, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('n'); // open new session
    await settle();

    const frame = lastFrame()!;
    expect(frame).toContain('/home/me/workspace-alpha');
    expect(frame).toContain('workspace-alpha');
    expect(frame.toLowerCase()).not.toContain('resume');
    expect(frame.toLowerCase()).not.toContain('recent');
    expect(frame).not.toContain('alpha]'); // no "[label]" summary decoration

    unmount();
  });

  // ── Test 3c: typing a path in NewSession shows a "Start in" row ──────────
  it('n opens NewSession; typing a path shows Start in row', async () => {
    const localPast = { sessionId: 'past-local', cwd: '/home/me/workspace-alpha', startedAt: 1, label: 'alpha' };
    const tower = makeMockTower([makeSession()], [localPast]);

    const { stdin, lastFrame, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('n'); // open new session
    await settle();
    stdin.write('/tmp/x'); // type a path
    await settle();

    const frame = lastFrame()!;
    expect(frame).toContain('Start in:');
    expect(frame).toContain('/tmp/x');

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

  // ── Test 5: ESC in search → no JSON, back on dashboard ─────────────────────
  it('ESC in search closes the overlay without writing JSON', async () => {
    const session = makeSession({ paneId: '%9', sessionId: 's-esc', label: 'gamma' });
    const tower = makeMockTower([session]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('/'); // open search
    await settle();
    stdin.write('\x1b'); // ESC → just close the overlay
    await settle(200);

    // Cancelling search writes nothing and does not exit the popup.
    expect(fs.existsSync(outputPath)).toBe(false);

    // Still on the dashboard and interactive: Enter now emits a go action.
    stdin.write('\r');
    await settle(200);
    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('go');
    expect(result.sessionId).toBe('s-esc');

    unmount();
  });

  // ── Test 6: 'R' → resume search → Enter on local past → action:'new' ───────
  it("R opens resume search; selecting a local past session writes new JSON with resumeSessionId", async () => {
    const localPast = { sessionId: 'past-local', cwd: '/home/me/projA', startedAt: 1, label: 'alpha' };
    const remotePast = { sessionId: 'past-remote', cwd: '/home/me/projR', startedAt: 2, label: 'remoteproj', sshTarget: 'me@host' };
    const tower = makeMockTower([makeSession()], [localPast, remotePast]);

    const { stdin, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('R'); // open resume search
    await settle();
    stdin.write('alpha'); // filter to the local past session
    await settle();
    stdin.write('\r'); // resurrect → action:'new'
    await settle(200);

    expect(fs.existsSync(outputPath)).toBe(true);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(result.action).toBe('new');
    expect(result.resumeSessionId).toBe('past-local');
    expect(result.cwd).toBe('/home/me/projA');
    expect(result.host).toBe('local');
    expect(result.sshTarget).toBe(null);

    unmount();
  });

  // ── Test 7: remote past sessions are hidden in picker mode ────────────────
  it('R resume search hides remote past sessions in picker mode', async () => {
    const localPast = { sessionId: 'past-local', cwd: '/home/me/projA', startedAt: 1, label: 'alphalocal' };
    const remotePast = { sessionId: 'past-remote', cwd: '/home/me/projR', startedAt: 2, label: 'betaremote', sshTarget: 'me@host' };
    const tower = makeMockTower([makeSession()], [localPast, remotePast]);

    const { stdin, lastFrame, unmount } = render(
      <App tower={tower} pickerMode={true} outputPath={outputPath} />,
    );

    await settle();
    stdin.write('R');
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alphalocal');     // local shown
    expect(frame).not.toContain('betaremote'); // remote filtered out in picker

    unmount();
  });

  // ── Test 8: non-picker resume search includes remote past sessions ────────
  it('R resume search includes remote past sessions in non-picker mode', async () => {
    const localPast = { sessionId: 'past-local', cwd: '/home/me/projA', startedAt: 1, label: 'alphalocal' };
    const remotePast = { sessionId: 'past-remote', cwd: '/home/me/projR', startedAt: 2, label: 'betaremote', sshTarget: 'me@host' };
    const tower = makeMockTower([makeSession()], [localPast, remotePast]);

    const { stdin, lastFrame, unmount } = render(
      <App tower={tower} pickerMode={false} />,
    );

    await settle();
    stdin.write('R');
    await settle();
    const frame = lastFrame()!;
    expect(frame).toContain('alphalocal');
    expect(frame).toContain('betaremote'); // remote included in non-picker

    unmount();
  });
});
