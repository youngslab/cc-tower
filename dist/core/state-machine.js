import { EventEmitter } from 'node:events';
export class SessionStateMachine extends EventEmitter {
    sessionId;
    state;
    stateEnteredAt;
    previousState; // for agent-stop recovery
    inactivityTimer = null;
    static INACTIVITY_TIMEOUT = 120000; // 2min — emit check event, tower verifies PID before going idle
    constructor(sessionId, initialState) {
        super();
        this.sessionId = sessionId;
        this.state = initialState;
        this.previousState = initialState;
        this.stateEnteredAt = Date.now();
    }
    getState() {
        return this.state;
    }
    getDuration() {
        return Date.now() - this.stateEnteredAt;
    }
    transition(event) {
        if (this.state === 'dead')
            return;
        const next = this.resolveNext(event);
        if (next === null || next === this.state)
            return;
        const change = {
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
    clearInactivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }
    /** Called by tower when PID is still alive — restart the inactivity timer without state transition. */
    resetInactivityTimer() {
        if (this.state === 'idle' || this.state === 'dead')
            return;
        this.clearInactivityTimer();
        this.inactivityTimer = setTimeout(() => {
            if (this.state !== 'idle' && this.state !== 'dead') {
                this.emit('inactivity-check', this.sessionId);
            }
        }, SessionStateMachine.INACTIVITY_TIMEOUT);
    }
    destroy() {
        this.clearInactivityTimer();
    }
    resolveNext(event) {
        // Handle JSONL-based events (fallback mode)
        if (event.type === 'jsonl') {
            if (event.stopReason === null)
                return 'thinking';
            if (event.stopReason === 'tool_use')
                return 'executing';
            if (event.stopReason === 'end_turn')
                return 'idle';
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
//# sourceMappingURL=state-machine.js.map