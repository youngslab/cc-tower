import { EventEmitter } from 'node:events';
export class SessionStateMachine extends EventEmitter {
    sessionId;
    state;
    stateEnteredAt;
    previousState; // for agent-stop recovery
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
            case 'session-end':
                return 'dead';
            case 'agent-start':
                return 'agent';
            case 'agent-stop':
                return this.previousState;
            case 'user-prompt':
                return this.state === 'idle' ? 'thinking' : null;
            case 'pre-tool':
                return this.state === 'thinking' ? 'executing' : null;
            case 'post-tool':
                return this.state === 'executing' ? 'thinking' : null;
            case 'stop':
                return this.state === 'thinking' ? 'idle' : null;
            default:
                return null;
        }
    }
}
//# sourceMappingURL=state-machine.js.map