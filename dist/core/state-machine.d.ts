import { EventEmitter } from 'node:events';
export type State = 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
export type InputEvent = {
    type: 'session-start';
} | {
    type: 'user-prompt';
} | {
    type: 'pre-tool';
} | {
    type: 'post-tool';
} | {
    type: 'agent-start';
} | {
    type: 'agent-stop';
} | {
    type: 'stop';
} | {
    type: 'session-end';
} | {
    type: 'jsonl';
    stopReason: 'end_turn' | 'tool_use' | null;
};
export interface StateChange {
    sessionId: string;
    from: State;
    to: State;
    event: InputEvent;
    timestamp: number;
    duration: number;
}
export declare class SessionStateMachine extends EventEmitter {
    private sessionId;
    private state;
    private stateEnteredAt;
    private previousState;
    private inactivityTimer;
    private static readonly INACTIVITY_TIMEOUT;
    constructor(sessionId: string, initialState: State);
    getState(): State;
    getDuration(): number;
    transition(event: InputEvent): void;
    private clearInactivityTimer;
    /** Called by tower when PID is still alive — restart the inactivity timer without state transition. */
    resetInactivityTimer(): void;
    destroy(): void;
    private resolveNext;
}
