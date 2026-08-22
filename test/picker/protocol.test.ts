import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { serialize, writeAndExit, type PickerAction } from '../../src/picker/protocol.js';

describe('picker/protocol — serialize', () => {
  it('emits a single newline-terminated JSON line for each action', () => {
    const cases: PickerAction[] = [
      {
        action: 'go',
        sessionId: 'abc-123',
        paneId: '%4',
        host: 'local',
        cwd: '/home/me/proj',
        sshTarget: null,
        agentId: 'claude',
      },
      {
        action: 'new',
        cwd: '/tmp/x',
        host: 'local',
        sshTarget: null,
        agentId: 'claude',
        resumeSessionId: null,
      },
      { action: 'cancel' },
    ];

    for (const payload of cases) {
      const out = serialize(payload);
      expect(out.endsWith('\n')).toBe(true);
      // Exactly one line (trailing newline only)
      expect(out.split('\n').filter(Boolean)).toHaveLength(1);
      // Round-trip
      const parsed = JSON.parse(out);
      expect(parsed).toEqual(payload);
    }
  });

  it('cancel serializes to compact JSON', () => {
    expect(serialize({ action: 'cancel' })).toBe('{"action":"cancel"}\n');
  });

  it('go payload preserves all routing fields', () => {
    const out = JSON.parse(serialize({
      action: 'go',
      sessionId: 's1',
      paneId: '%2',
      host: 'remote-A',
      cwd: '/a/b',
      sshTarget: 'user@host',
      agentId: 'claude',
    }));
    expect(out.sessionId).toBe('s1');
    expect(out.paneId).toBe('%2');
    expect(out.sshTarget).toBe('user@host');
    expect(out.agentId).toBe('claude');
  });
});

describe('picker/protocol — writeAndExit (subprocess)', () => {
  it('atomic-writes the JSON to outputPath and exits 0', async () => {
    // writeAndExit calls process.exit, so we must run it in a child process.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-test-'));
    const outputPath = path.join(tmpDir, 'out.json');
    const scriptPath = path.join(tmpDir, 'driver.mjs');
    const protocolPath = path.resolve(
      new URL('../../src/picker/protocol.ts', import.meta.url).pathname,
    );

    // Tiny driver: import via tsx-compatible path (we re-stringify the path).
    fs.writeFileSync(scriptPath, `
import { writeAndExit } from ${JSON.stringify(protocolPath)};
writeAndExit(${JSON.stringify(outputPath)}, { action: 'cancel' });
`);

    const { spawnSync } = await import('node:child_process');
    const res = spawnSync('npx', ['tsx', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
    const contents = fs.readFileSync(outputPath, 'utf8');
    expect(contents).toBe('{"action":"cancel"}\n');
    expect(JSON.parse(contents)).toEqual({ action: 'cancel' });

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 35_000);
});

describe('picker/protocol — agent routing', () => {
  it('new payload can carry codex agentId and resume UUID', () => {
    const payload: PickerAction = {
      action: 'new',
      cwd: '/repo',
      host: 'local',
      sshTarget: null,
      agentId: 'codex',
      resumeSessionId: '019f-codex-thread',
    };
    expect(JSON.parse(serialize(payload))).toEqual(payload);
  });

  it('popmux-go forwards picker send agentId into popmux send', () => {
    const script = fs.readFileSync(path.resolve('bin/popmux-go'), 'utf8');
    expect(script).toContain('AGENT=$(jq -r \'.agentId // "claude"\' <"$OUT")');
    expect(script).toContain('"$POPMUX" send --agent "$AGENT" "$SID" "$MSG"');
  });

  it('popmux-go forwards picker new agentId into popmux spawn', () => {
    const script = fs.readFileSync(path.resolve('bin/popmux-go'), 'utf8');
    expect(script).toContain('AGENT=$(jq -r \'.agentId // "claude"\' <"$OUT")');
    expect(script).toContain('SPAWN_ARGS=("--cwd" "$CWD" "--agent" "$AGENT")');
    expect(script).toContain('"$POPMUX" spawn "${SPAWN_ARGS[@]}"');
  });

  it('popmux spawn uses shared agent command builder and argv-based tmux execution', () => {
    const source = fs.readFileSync(path.resolve('src/index.tsx'), 'utf8');
    expect(source).toContain('buildAgentCommand({');
    expect(source).toContain('agentId,');
    expect(source).toContain('resumeId: opts.resume,');
    expect(source).toContain("claudeBin: agentId === 'claude' ? resolveClaudeBin() : undefined");
    expect(source).toContain("const tmuxArgs = ['new-window', '-c', cwd, '-n', windowName, cmd]");
    expect(source).toContain("spawnSync('tmux', tmuxArgs, { stdio: 'inherit' })");
    expect(source).not.toContain('execSync(`tmux new-window');
  });
});
