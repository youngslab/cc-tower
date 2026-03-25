import { readFileSync, readlinkSync } from 'fs';

export interface PaneMatch {
  paneId: string;    // e.g., "%7"
  tty: string;       // e.g., "/dev/pts/34"
  ancestorPid: number; // the PID whose TTY matched
}

/**
 * Read the ppid of a process from /proc/<pid>/stat (field index 3, 0-based).
 * Returns null if the file cannot be read or parsed.
 */
export function getPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Format: pid (comm) state ppid ...
    // The comm field may contain spaces/parens, so find the last ')' first.
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) return null;
    const rest = stat.slice(lastParen + 1).trim().split(/\s+/);
    // rest[0] = state, rest[1] = ppid
    const ppid = parseInt(rest[1] ?? '', 10);
    if (isNaN(ppid)) return null;
    return ppid;
  } catch {
    return null;
  }
}

/**
 * Get the controlling TTY device path for a process by reading /proc/<pid>/fd/0.
 * Returns null if not available or process not found.
 */
export function getTty(pid: number): string | null {
  try {
    const fd0 = readlinkSync(`/proc/${pid}/fd/0`);
    if (fd0.startsWith('/dev/pts/')) return fd0;
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk the ppid chain from `pid` upward until either:
 * 1. The ancestor PID matches a tmux pane PID directly (primary), or
 * 2. The ancestor TTY matches a tmux pane TTY (fallback).
 * Returns null if no match is found.
 */
export async function resolvePaneForPid(
  pid: number,
  paneList: Array<{ paneId: string; tty: string; pid: number }>,
): Promise<PaneMatch | null> {
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
    if (ppid === null || ppid === current || ppid <= 1) break;
    current = ppid;
  }

  return null;
}
