import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSshConfig, checkSsh, RECOMMENDED } from '../../src/cli/check-ssh.js';

// ---------------------------------------------------------------------------
// parseSshConfig
// ---------------------------------------------------------------------------
describe('parseSshConfig', () => {
  it('extracts Host blocks with options', () => {
    const cfg = `
Host server-a
  HostName 1.2.3.4
  ControlMaster auto

Host *
  ControlPath ~/.ssh/cm-%r@%h:%p
`;
    const blocks = parseSshConfig(cfg);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      host: 'server-a',
      options: expect.objectContaining({ ControlMaster: 'auto', HostName: '1.2.3.4' }),
    });
    expect(blocks[1]!.options['ControlPath']).toBe('~/.ssh/cm-%r@%h:%p');
  });

  it('normalizes RECOMMENDED option keys to canonical casing', () => {
    const cfg = 'Host x\n  controlmaster auto\n  controlpersist 10m\n';
    const blocks = parseSshConfig(cfg);
    expect(blocks[0]!.options['ControlMaster']).toBe('auto');
    expect(blocks[0]!.options['ControlPersist']).toBe('10m');
  });

  it('ignores comments and blank lines', () => {
    const cfg = `
# This is a comment
Host myhost
  # inline comment

  ControlMaster auto

`;
    const blocks = parseSshConfig(cfg);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.host).toBe('myhost');
    expect(blocks[0]!.options['ControlMaster']).toBe('auto');
  });

  it('handles multiple Host blocks correctly', () => {
    const cfg = `
Host alpha
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m

Host beta
  ControlMaster yes

Host *
  ServerAliveInterval 60
`;
    const blocks = parseSshConfig(cfg);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.host).toBe('alpha');
    expect(blocks[1]!.host).toBe('beta');
    expect(blocks[2]!.host).toBe('*');
    expect(blocks[2]!.options['ServerAliveInterval']).toBe('60');
  });

  it('returns empty array for empty config', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('# just comments\n\n')).toEqual([]);
  });

  it('handles = separator between key and value', () => {
    const cfg = 'Host x\n  ControlMaster=auto\n';
    const blocks = parseSshConfig(cfg);
    expect(blocks[0]!.options['ControlMaster']).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// checkSsh — uses a temp file to avoid touching ~/.ssh/config
// ---------------------------------------------------------------------------
describe('checkSsh', () => {
  let tmpDir: string;
  let tmpConfig: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ssh-test-'));
    tmpConfig = path.join(tmpDir, 'config');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports missing config file with ok=false', () => {
    const result = checkSsh(undefined, path.join(tmpDir, 'nonexistent'));
    expect(result.ok).toBe(false);
    expect(result.report).toContain('not found');
    expect(result.report).toContain('ControlMaster');
  });

  it('reports all RECOMMENDED options for a matching host', () => {
    fs.writeFileSync(tmpConfig, `
Host myserver
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
`);
    const result = checkSsh('myserver', tmpConfig);
    expect(result.ok).toBe(true);
    expect(result.report).toContain('Host myserver');
    for (const key of Object.keys(RECOMMENDED)) {
      expect(result.report).toContain(key);
    }
    // All options present → no recommendation block at the end
    expect(result.report).not.toContain('To enable ControlMaster');
  });

  it('flags missing options against RECOMMENDED with ok=false', () => {
    fs.writeFileSync(tmpConfig, `
Host *
  ControlMaster auto
`);
    const result = checkSsh(undefined, tmpConfig);
    expect(result.ok).toBe(false);
    expect(result.report).toContain('ControlPath');
    expect(result.report).toContain('(missing)');
    expect(result.report).toContain('To enable ControlMaster');
  });

  it('falls back to wildcard Host * when targetHost not found', () => {
    fs.writeFileSync(tmpConfig, `
Host *
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
`);
    const result = checkSsh('nonexistent-host', tmpConfig);
    expect(result.ok).toBe(true);
    expect(result.report).toContain('Host *');
  });

  it('returns ok=false when config exists but has no Host blocks', () => {
    fs.writeFileSync(tmpConfig, '# no hosts here\n\n');
    const result = checkSsh(undefined, tmpConfig);
    expect(result.ok).toBe(false);
    expect(result.report).toContain('no Host blocks');
  });

  it('marks differing values with ~ and shows recommended', () => {
    fs.writeFileSync(tmpConfig, `
Host *
  ControlMaster yes
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 5m
`);
    const result = checkSsh(undefined, tmpConfig);
    expect(result.ok).toBe(false);
    // ControlMaster 'yes' differs from recommended 'auto'
    expect(result.report).toContain('recommended: auto');
    // ControlPersist '5m' differs from recommended '10m'
    expect(result.report).toContain('recommended: 10m');
  });
});
