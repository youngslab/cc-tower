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
 * Read the command-line arguments of a process from /proc/<pid>/cmdline.
 * Returns null if not available.
 */
export declare function getCmdline(pid: number): string[] | null;
/**
 * Returns true if the given process is alive (responds to signal 0).
 */
export declare function isPidAlive(pid: number): boolean;
/**
 * Returns true if the process (or any ancestor) was invoked with --print,
 * indicating a headless/non-interactive Claude session.
 */
export declare function isHeadlessProcess(pid: number): boolean;
/**
 * Walk the ppid chain from `pid` upward until either:
 * 1. The ancestor PID matches a tmux pane PID directly (primary), or
 * 2. The ancestor TTY matches a tmux pane TTY (fallback).
 * Returns null if no match is found.
 */
export declare function resolvePaneForPid(pid: number, paneList: Array<{
    paneId: string;
    tty: string;
    pid: number;
}>): Promise<PaneMatch | null>;
