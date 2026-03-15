import { describe, it, expect } from 'vitest';
import { SessionStateMachine, State, InputEvent } from '../../src/core/state-machine.js';

describe('SessionStateMachine', () => {
  it('starts in the given initial state', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    expect(fsm.getState()).toBe('idle');
  });

  // Core transitions from PRD FR-5:
  // idle → thinking (UserPromptSubmit / user message)
  it('transitions idle → thinking on user-prompt', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    fsm.transition({ type: 'user-prompt' });
    expect(fsm.getState()).toBe('thinking');
  });

  // thinking → executing (PreToolUse / tool_use)
  it('transitions thinking → executing on pre-tool', () => {
    const fsm = new SessionStateMachine('s1', 'thinking');
    fsm.transition({ type: 'pre-tool' });
    expect(fsm.getState()).toBe('executing');
  });

  // executing → thinking (PostToolUse)
  it('transitions executing → thinking on post-tool', () => {
    const fsm = new SessionStateMachine('s1', 'executing');
    fsm.transition({ type: 'post-tool' });
    expect(fsm.getState()).toBe('thinking');
  });

  // thinking → idle (Stop / end_turn)
  it('transitions thinking → idle on stop', () => {
    const fsm = new SessionStateMachine('s1', 'thinking');
    fsm.transition({ type: 'stop' });
    expect(fsm.getState()).toBe('idle');
  });

  // * → agent (SubagentStart)
  it('transitions to agent on agent-start', () => {
    const fsm = new SessionStateMachine('s1', 'thinking');
    fsm.transition({ type: 'agent-start' });
    expect(fsm.getState()).toBe('agent');
  });

  // agent → previous on agent-stop
  it('transitions agent → thinking on agent-stop', () => {
    const fsm = new SessionStateMachine('s1', 'thinking');
    fsm.transition({ type: 'agent-start' });
    expect(fsm.getState()).toBe('agent');
    fsm.transition({ type: 'agent-stop' });
    expect(fsm.getState()).toBe('thinking');
  });

  // * → dead (session-end)
  it('transitions to dead on session-end', () => {
    const fsm = new SessionStateMachine('s1', 'executing');
    fsm.transition({ type: 'session-end' });
    expect(fsm.getState()).toBe('dead');
  });

  // dead state is terminal
  it('ignores transitions from dead state', () => {
    const fsm = new SessionStateMachine('s1', 'dead');
    fsm.transition({ type: 'user-prompt' });
    expect(fsm.getState()).toBe('dead');
  });

  // Invalid transition ignored
  it('ignores invalid transitions', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    fsm.transition({ type: 'post-tool' }); // can't post-tool from idle
    expect(fsm.getState()).toBe('idle');
  });

  // Full cycle: idle → thinking → executing → thinking → idle
  it('handles full turn cycle', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    fsm.transition({ type: 'user-prompt' });
    expect(fsm.getState()).toBe('thinking');
    fsm.transition({ type: 'pre-tool' });
    expect(fsm.getState()).toBe('executing');
    fsm.transition({ type: 'post-tool' });
    expect(fsm.getState()).toBe('thinking');
    fsm.transition({ type: 'pre-tool' });
    expect(fsm.getState()).toBe('executing');
    fsm.transition({ type: 'post-tool' });
    expect(fsm.getState()).toBe('thinking');
    fsm.transition({ type: 'stop' });
    expect(fsm.getState()).toBe('idle');
  });

  // Emits state-change events
  it('emits state-change event on valid transition', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    const changes: Array<{from: State; to: State}> = [];
    fsm.on('state-change', (change) => changes.push(change));

    fsm.transition({ type: 'user-prompt' });

    expect(changes.length).toBe(1);
    expect(changes[0].from).toBe('idle');
    expect(changes[0].to).toBe('thinking');
  });

  it('does not emit event on ignored transition', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    const changes: any[] = [];
    fsm.on('state-change', (change) => changes.push(change));

    fsm.transition({ type: 'post-tool' }); // invalid from idle

    expect(changes.length).toBe(0);
  });

  // getDuration returns time since last state change
  it('tracks duration since last state change', async () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    await new Promise(r => setTimeout(r, 50));
    expect(fsm.getDuration()).toBeGreaterThanOrEqual(40);
  });

  // JSONL-based events (for fallback mode)
  it('handles jsonl-based stop_reason events', () => {
    const fsm = new SessionStateMachine('s1', 'idle');
    fsm.transition({ type: 'jsonl', stopReason: null }); // streaming = thinking
    expect(fsm.getState()).toBe('thinking');

    fsm.transition({ type: 'jsonl', stopReason: 'tool_use' });
    expect(fsm.getState()).toBe('executing');

    // After tool_use, next null means thinking again
    fsm.transition({ type: 'jsonl', stopReason: null });
    expect(fsm.getState()).toBe('thinking');

    fsm.transition({ type: 'jsonl', stopReason: 'end_turn' });
    expect(fsm.getState()).toBe('idle');
  });
});
