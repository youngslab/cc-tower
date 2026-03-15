import { readFileSync } from 'fs';
import { execSync } from 'child_process';

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
 * Get the controlling TTY device path for a process using `ps`.
 * Returns null if not available or process not found.
 */
export function getTty(pid: number): string | null {
  try {
    const out = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!out || out === '?' || out === '') return null;
    // ps returns just the device name (e.g. "pts/34"); prepend /dev/ if needed
    if (out.startsWith('/')) return out;
    return `/dev/${out}`;
  } catch {
    return null;
  }
}

/**
 * Walk the ppid chain from `pid` upward until a TTY matches one of the
 * provided tmux pane TTYs. Returns null if no match is found (e.g. a
 * Monitor-only session with no tmux pane).
 */
export async function resolvePaneForPid(
  pid: number,
  paneList: Array<{ paneId: string; tty: string }>,
): Promise<PaneMatch | null> {
  let current = pid;

  while (current > 1) {
    const tty = getTty(current);
    if (tty !== null) {
      const match = paneList.find((p) => p.tty === tty);
      if (match) {
        return { paneId: match.paneId, tty: match.tty, ancestorPid: current };
      }
    }

    const ppid = getPpid(current);
    if (ppid === null || ppid === current || ppid <= 1) break;
    current = ppid;
  }

  return null;
}
