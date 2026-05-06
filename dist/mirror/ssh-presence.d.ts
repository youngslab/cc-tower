/**
 * Check if a tmux pane has a live `ssh` child process.
 *
 * @param panePid - PID reported by tmux as `#{pane_pid}` (the pane's top-level
 *                  process — typically the shell, but in our case it can be
 *                  the ssh process itself when the pane was started with
 *                  `tmux new-window <cmd>`).
 * @returns true iff a live ssh process is running as a direct child OR is the
 *          pane's pid itself (handles both wrapping styles).
 */
export declare function isSshAlive(panePid: number): Promise<boolean>;
