import { HostConfig } from '../config/defaults.js';

/** The host shape `handleNewSession` expects (camelCase commandPrefix). */
export interface ResolvedHost {
  name: string;
  ssh: string;
  commandPrefix?: string;
}

/**
 * Resolve a past session's `sshTarget` to a configured host object.
 * Returns undefined for local sessions (no sshTarget) or when no configured
 * host matches the target. Mirrors the inline `hosts.find(h => h.ssh === ...)`
 * pattern used in App.tsx / NewSession.tsx, mapping command_prefix→commandPrefix.
 */
export function resolveHostBySsh(hosts: HostConfig[], sshTarget?: string): ResolvedHost | undefined {
  if (!sshTarget) return undefined;
  const host = hosts.find(h => h.ssh === sshTarget);
  if (!host) return undefined;
  return { name: host.name, ssh: host.ssh, commandPrefix: host.command_prefix };
}
