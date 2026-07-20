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
export declare function resolveHostBySsh(hosts: HostConfig[], sshTarget?: string): ResolvedHost | undefined;
