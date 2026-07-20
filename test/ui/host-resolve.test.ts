import { describe, it, expect } from 'vitest';
import { resolveHostBySsh } from '../../src/ui/host-resolve.js';
import type { HostConfig } from '../../src/config/defaults.js';

const hosts: HostConfig[] = [
  { name: 'server-a', ssh: 'me@a', hooks: true, command_prefix: 'docker exec dev' },
  { name: 'server-b', ssh: 'me@b', hooks: false },
];

describe('resolveHostBySsh', () => {
  it('returns the configured host (mapping command_prefix→commandPrefix)', () => {
    expect(resolveHostBySsh(hosts, 'me@a')).toEqual({
      name: 'server-a',
      ssh: 'me@a',
      commandPrefix: 'docker exec dev',
    });
  });
  it('returns a host without commandPrefix when none configured', () => {
    expect(resolveHostBySsh(hosts, 'me@b')).toEqual({
      name: 'server-b',
      ssh: 'me@b',
      commandPrefix: undefined,
    });
  });
  it('returns undefined for an unknown ssh target', () => {
    expect(resolveHostBySsh(hosts, 'me@unknown')).toBeUndefined();
  });
  it('returns undefined when sshTarget is absent (local session)', () => {
    expect(resolveHostBySsh(hosts, undefined)).toBeUndefined();
  });
});
