import { readFileSync, readlinkSync } from 'fs';
/**
 * Read the ppid of a process from /proc/<pid>/stat (field index 3, 0-based).
 * Returns null if the file cannot be read or parsed.
 */
export function getPpid(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Format: pid (comm) state ppid ...
        // The comm field may contain spaces/parens, so find the last ')' first.
        const lastParen = stat.lastIndexOf(')');
        if (lastParen === -1)
            return null;
        const rest = stat.slice(lastParen + 1).trim().split(/\s+/);
        // rest[0] = state, rest[1] = ppid
        const ppid = parseInt(rest[1] ?? '', 10);
        if (isNaN(ppid))
            return null;
        return ppid;
    }
    catch {
        return null;
    }
}
/**
 * Get the controlling TTY device path for a process by reading /proc/<pid>/fd/0.
 * Returns null if not available or process not found.
 */
export function getTty(pid) {
    try {
        const fd0 = readlinkSync(`/proc/${pid}/fd/0`);
        if (fd0.startsWith('/dev/pts/'))
            return fd0;
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Read the command-line arguments of a process from /proc/<pid>/cmdline.
 * Returns null if not available.
 */
export function getCmdline(pid) {
    try {
        const raw = readFileSync(`/proc/${pid}/cmdline`);
        return raw.toString().split('\0').filter(Boolean);
    }
    catch {
        return null;
    }
}
/**
 * Returns true if the given process is alive (responds to signal 0).
 */
export function isPidAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        if (err?.code === 'EPERM')
            return true; // process exists but no permission
        return false;
    }
}
/**
 * Returns true if the process (or any ancestor) was invoked with --print,
 * indicating a headless/non-interactive Claude session.
 */
export function isHeadlessProcess(pid) {
    let current = pid;
    let depth = 0;
    while (current > 1 && depth < 10) {
        const args = getCmdline(current);
        if (args && args.some(a => a === '--print' || a === '-p'))
            return true;
        const ppid = getPpid(current);
        if (ppid === null || ppid === current || ppid <= 1)
            break;
        current = ppid;
        depth++;
    }
    return false;
}
/**
 * Walk the ppid chain from `pid` upward until either:
 * 1. The ancestor PID matches a tmux pane PID directly (primary), or
 * 2. The ancestor TTY matches a tmux pane TTY (fallback).
 * Returns null if no match is found.
 */
export async function resolvePaneForPid(pid, paneList) {
    const panePidMap = new Map(paneList.map((p) => [p.pid, p]));
    let current = pid;
    while (current > 1) {
        // Primary: match by PID directly
        const pidMatch = panePidMap.get(current);
        if (pidMatch) {
            return { paneId: pidMatch.paneId, tty: pidMatch.tty, ancestorPid: current };
        }
        // Fallback: match by TTY
        const tty = getTty(current);
        if (tty !== null) {
            const ttyMatch = paneList.find((p) => p.tty === tty);
            if (ttyMatch) {
                return { paneId: ttyMatch.paneId, tty: ttyMatch.tty, ancestorPid: current };
            }
        }
        const ppid = getPpid(current);
        if (ppid === null || ppid === current || ppid <= 1)
            break;
        current = ppid;
    }
    return null;
}
//# sourceMappingURL=pid-resolver.js.map