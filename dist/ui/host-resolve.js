/**
 * Resolve a past session's `sshTarget` to a configured host object.
 * Returns undefined for local sessions (no sshTarget) or when no configured
 * host matches the target. Mirrors the inline `hosts.find(h => h.ssh === ...)`
 * pattern used in App.tsx / NewSession.tsx, mapping command_prefix→commandPrefix.
 */
export function resolveHostBySsh(hosts, sshTarget) {
    if (!sshTarget)
        return undefined;
    const host = hosts.find(h => h.ssh === sshTarget);
    if (!host)
        return undefined;
    return { name: host.name, ssh: host.ssh, commandPrefix: host.command_prefix };
}
//# sourceMappingURL=host-resolve.js.map