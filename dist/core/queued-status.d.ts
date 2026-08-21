import type { Session } from './session-store.js';
/** Statuses considered "running" for attention-banner transition detection. */
export declare const RUNNING_STATUSES: Set<"idle" | "thinking" | "executing" | "agent" | "dead">;
/**
 * Pure transition check for the attention banner: a session needs attention
 * when it goes from a running status straight to idle unobserved.
 *
 * Any confirmed-running observation clears it, regardless of prevStatus: the
 * spec originally scoped clearing to the popmux Go action only, but that's a
 * blind spot for anyone who works directly in tmux without going through
 * popmux. It's also insufficient across restarts — each fresh readOnly
 * picker process only sees one prevStatus→nextStatus edge, so a genuine
 * idle→running transition that happened while no process was watching is
 * invisible, and a strict idle-only precondition would leave the flag stuck.
 * Since "needs attention" only matters while idle, any live confirmation
 * that the session is busy again (from a hook OR the pane-title reconciler)
 * makes a stale flag from an earlier cycle moot.
 *
 * Returns `undefined` for all other transitions so callers can merge the
 * result into a patch without ever touching the existing flag.
 */
export declare function computeNeedsAttention(prevStatus: Session['status'], nextStatus: Session['status']): boolean | undefined;
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
