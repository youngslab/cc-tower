/**
 * SSH child-process presence detection for tmux mirror windows.
 *
 * A mirror window's pane runs `ssh -t <target> 'tmux attach -t <pane>'`. When
 * the remote ssh session ends (network drop, remote tmux dies, user pressed
 * `prefix+d` on the remote, etc.), the local shell stays alive but the ssh
 * child process exits. We use that signal to decide whether the mirror is
 * still usable.
 *
 * Heuristic: `pgrep -P <pane_pid> -x ssh` finds direct children of the pane's
 * shell whose comm is exactly "ssh". Exit code 0 with non-empty stdout = at
 * least one live ssh child.
 */
import { execa } from 'execa';

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
export async function isSshAlive(panePid: number): Promise<boolean> {
  if (!Number.isFinite(panePid) || panePid <= 0) return false;

  // Case 1: pane_pid IS the ssh process (when tmux new-window started ssh
  // directly without an intermediate shell). Check `ps -p <pid> -o comm=`.
  try {
    const psSelf = await execa('ps', ['-p', String(panePid), '-o', 'comm='], { reject: false });
    if (psSelf.exitCode === 0 && psSelf.stdout.trim() === 'ssh') {
      return true;
    }
  } catch {
    // ignore — fall through to pgrep
  }

  // Case 2: a child process of pane_pid is ssh (when tmux started a shell
  // that exec'd ssh, or when ssh is run via `sh -c`).
  try {
    const result = await execa('pgrep', ['-P', String(panePid), '-x', 'ssh'], { reject: false });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
