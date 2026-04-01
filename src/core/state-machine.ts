import { EventEmitter } from 'node:events';

export type State = 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';

export type InputEvent =
  | { type: 'session-start' }
  | { type: 'user-prompt' }
  | { type: 'pre-tool' }
  | { type: 'post-tool' }
  | { type: 'agent-start' }
  | { type: 'agent-stop' }
  | { type: 'stop' }
  | { type: 'session-end' }
  | { type: 'jsonl'; stopReason: 'end_turn' | 'tool_use' | null };

export interface StateChange {
  sessionId: string;
  from: State;
  to: State;
  event: InputEvent;
  timestamp: number;
  duration: number; // ms in previous state
}

export class SessionStateMachine extends EventEmitter {
  private state: State;
  private stateEnteredAt: number;
  private previousState: State; // for agent-stop recovery
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_TIMEOUT = 120000; // 2min — emit check event, tower verifies PID before going idle

  constructor(
    private sessionId: string,
    initialState: State,
  ) {
    super();
    this.state = initialState;
    this.previousState = initialState;
    this.stateEnteredAt = Date.now();
  }

  getState(): State {
    return this.state;
  }

  getDuration(): number {
    return Date.now() - this.stateEnteredAt;
  }

  transition(event: InputEvent): void {
    if (this.state === 'dead') return;

    const next = this.resolveNext(event);
    if (next === null || next === this.state) return;

    const change: StateChange = {
      sessionId: this.sessionId,
      from: this.state,
      to: next,
      event,
      timestamp: Date.now(),
      duration: this.getDuration(),
    };

    if (event.type === 'agent-start') {
      this.previousState = this.state;
    }

    this.state = next;
    this.stateEnteredAt = Date.now();
    this.emit('state-change', change);

    // Reset inactivity timer: active states get a timeout, idle/dead don't
    this.clearInactivityTimer();
    if (next !== 'idle' && next !== 'dead') {
      this.inactivityTimer = setTimeout(() => {
        if (this.state !== 'idle' && this.state !== 'dead') {
          // Emit check event instead of forcing idle — tower.ts verifies PID liveness
          // before deciding whether to transition to idle.
          this.emit('inactivity-check', this.sessionId);
        }
      }, SessionStateMachine.INACTIVITY_TIMEOUT);
    }
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  /** Called by tower when PID is still alive — restart the inactivity timer without state transition. */
  resetInactivityTimer(): void {
    if (this.state === 'idle' || this.state === 'dead') return;
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (this.state !== 'idle' && this.state !== 'dead') {
        this.emit('inactivity-check', this.sessionId);
      }
    }, SessionStateMachine.INACTIVITY_TIMEOUT);
  }

  destroy(): void {
    this.clearInactivityTimer();
  }

  private resolveNext(event: InputEvent): State | null {
    // Handle JSONL-based events (fallback mode)
    if (event.type === 'jsonl') {
      if (event.stopReason === null) return 'thinking';
      if (event.stopReason === 'tool_use') return 'executing';
      if (event.stopReason === 'end_turn') return 'idle';
      return null;
    }

    // Handle hook-based events
    switch (event.type) {
      case 'session-start':
        return this.state === 'idle' ? 'idle' : null; // acknowledge but no transition
      case 'session-end':
        return 'dead';
      case 'agent-start':
        return 'agent';
      case 'agent-stop':
        return this.previousState;
      case 'user-prompt':
        return this.state === 'idle' ? 'thinking' : null;
      case 'pre-tool':
        return (this.state === 'thinking' || this.state === 'idle') ? 'executing' : null;
      case 'post-tool':
        return this.state === 'executing' ? 'thinking' : null;
      case 'stop':
        return this.state !== 'idle' && this.state !== 'dead' ? 'idle' : null;
      default:
        return null;
    }
  }
}
