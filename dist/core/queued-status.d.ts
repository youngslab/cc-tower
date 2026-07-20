import type { Session } from './session-store.js';
/**
 * Resolve the status for a drained hook-queue event (readOnly/picker path — no FSM).
 *
 * Liveness note: event.pid is the EPHEMERAL hook-wrapper PID (popmux-hook.sh writes
 * `$PPID`, the shell Claude spawns the hook in), which is already dead by the time
 * the queue is drained — so it must NOT be used to gate "active" statuses (doing so
 * forced every thinking/executing/agent to idle). The session's tmux pane is the
 * stable liveness signal: an active status is only downgraded to idle when the
 * session's pane is known but no longer live.
 */
export declare function resolveQueuedStatus(event: {
    event?: unknown;
    pane?: unknown;
}, livePanes: Set<string>): Session['status'] | undefined;
