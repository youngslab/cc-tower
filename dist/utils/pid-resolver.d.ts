export interface PaneMatch {
    paneId: string;
    tty: string;
    ancestorPid: number;
}
/**
 * Read the ppid of a process from /proc/<pid>/stat (field index 3, 0-based).
 * Returns null if the file cannot be read or parsed.
 */
export declare function getPpid(pid: number): number | null;
/**
 * Get the controlling TTY device path for a process by reading /proc/<pid>/fd/0.
 * Returns null if not available or process not found.
 */
export declare function getTty(pid: number): string | null;
/**
 * Walk the ppid chain from `pid` upward until a TTY matches one of the
 * provided tmux pane TTYs. Returns null if no match is found (e.g. a
 * Monitor-only session with no tmux pane).
 */
export declare function resolvePaneForPid(pid: number, paneList: Array<{
    paneId: string;
    tty: string;
}>): Promise<PaneMatch | null>;
