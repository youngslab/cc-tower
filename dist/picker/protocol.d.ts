export type PickerAction = {
    action: 'go';
    sessionId: string;
    paneId: string;
    host: string;
    cwd: string;
    sshTarget: string | null;
    agentId: string;
} | {
    action: 'send';
    sessionId: string;
    paneId: string;
    host: string;
    sshTarget: string | null;
    agentId: string;
    text: string;
} | {
    action: 'new';
    cwd: string;
    host: string;
    sshTarget: string | null;
    agentId: string;
    resumeSessionId: string | null;
} | {
    action: 'cancel';
};
/**
 * Pure serializer — single-line JSON terminated with '\n'.
 * Exposed separately from `writeAndExit` so unit tests can validate the wire
 * format without spawning a subprocess.
 */
export declare function serialize(payload: PickerAction): string;
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
export declare function writeAndExit(outputPath: string, payload: PickerAction): never;
/** Mark the spawn time. Call as early as possible in the picker entrypoint. */
export declare function markSpawn(): void;
/**
 * Emit a one-shot READY signal to stderr.
 * Format: `READY <ms>\n` where <ms> is rounded ms since `markSpawn()`.
 * Idempotent — subsequent calls are no-ops.
 */
export declare function emitReady(): void;
