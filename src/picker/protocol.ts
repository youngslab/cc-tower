/**
 * Picker mode protocol — single-line JSON written to a tmpfile, then exit.
 *
 * Used by `popmux --picker --output <path>` (currently `popmux --picker`).
 * The TUI renders normally, but action keys cause the process to atomic-write
 * a result JSON to <path> and immediately `process.exit(0)`. A wrapper script
 * (e.g. invoked from `tmux display-popup -E`) reads the file after the popup
 * closes to decide what to do next (switch-client, send-keys, new-session, …).
 */
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';

export type PickerAction =
  | {
      action: 'go';
      sessionId: string;
      paneId: string;
      host: string;
      cwd: string;
      sshTarget: string | null;
      agentId: string;
    }
  | {
      action: 'send';
      sessionId: string;
      paneId: string;
      host: string;
      sshTarget: string | null;
      agentId: string;
      text: string;
    }
  | {
      action: 'new';
      cwd: string;
      host: string;
      sshTarget: string | null;
      agentId: string;
      resumeSessionId: string | null;
    }
  | { action: 'cancel' };

/**
 * Pure serializer — single-line JSON terminated with '\n'.
 * Exposed separately from `writeAndExit` so unit tests can validate the wire
 * format without spawning a subprocess.
 */
export function serialize(payload: PickerAction): string {
  return JSON.stringify(payload) + '\n';
}

/**
 * Atomic write of picker result to outputPath, then `process.exit(0)`.
 *
 * Implementation notes:
 *  - `writeFileSync` + `fsyncSync` flush data to disk before exit so the
 *    wrapper script (parent) sees the file contents immediately.
 *  - Single-line JSON keeps the wire format trivially shell-parseable
 *    (`head -1`, `jq -r .action`, …).
 *  - This function NEVER returns; callers can treat it as `never`.
 */
export function writeAndExit(outputPath: string, payload: PickerAction): never {
  const line = serialize(payload);
  let fd: number | null = null;
  try {
    fd = fs.openSync(outputPath, 'w');
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  process.exit(0);
}

// === READY signal (perf SLO) ============================================
// The wrapper script measures spawn → first frame to verify the < 800ms SLO.
// We emit a single line "READY <ms_since_spawn>\n" to stderr after ink's
// first render. stdout is reserved for the picker output file (and /dev/tty
// when stdout-redirect is enabled), stderr is debug-only.

let _spawnTime: number | null = null;
let _readyEmitted = false;

/** Mark the spawn time. Call as early as possible in the picker entrypoint. */
export function markSpawn(): void {
  _spawnTime = performance.now();
}

/**
 * Emit a one-shot READY signal to stderr.
 * Format: `READY <ms>\n` where <ms> is rounded ms since `markSpawn()`.
 * Idempotent — subsequent calls are no-ops.
 */
export function emitReady(): void {
  if (_readyEmitted) return;
  if (_spawnTime === null) _spawnTime = performance.now();
  const ms = Math.round(performance.now() - _spawnTime);
  try {
    process.stderr.write(`READY ${ms}\n`);
  } catch {}
  _readyEmitted = true;
}
