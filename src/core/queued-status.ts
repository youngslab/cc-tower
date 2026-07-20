import type { Session } from './session-store.js';

/** Maps a hook-queue event name to the session status it implies. */
const STATUS_MAP: Record<string, Session['status']> = {
  'pre-tool': 'executing',
  'post-tool': 'idle',
  'user-prompt': 'thinking',
  'thinking': 'thinking',
  'session-start': 'idle',
  'session-end': 'dead',
  'agent-start': 'agent',
  'agent-end': 'idle',
  'stop': 'idle',
  'executing': 'executing',
};

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
export function resolveQueuedStatus(
  event: { event?: unknown; pane?: unknown },
  livePanes: Set<string>,
): Session['status'] | undefined {
  if (typeof event.event !== 'string') return undefined;
  const status = STATUS_MAP[event.event];
  if (!status) return undefined;

  const isActive = status === 'thinking' || status === 'executing' || status === 'agent';
  const pane = typeof event.pane === 'string' && event.pane.startsWith('%') ? event.pane : undefined;
  if (isActive && pane && !livePanes.has(pane)) return 'idle';
  return status;
}
