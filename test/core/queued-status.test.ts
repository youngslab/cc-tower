import { describe, it, expect } from 'vitest';
import { resolveQueuedStatus, computeNeedsAttention } from '../../src/core/queued-status.js';

const live = new Set(['%2']);

describe('resolveQueuedStatus', () => {
  // Regression: the bug was that event.pid (ephemeral hook-wrapper PID, always
  // dead at drain time) forced every active status to idle. With a live pane,
  // active statuses must be preserved.
  it('preserves active status when the pane is live (regression: not forced idle)', () => {
    expect(resolveQueuedStatus({ event: 'pre-tool', pane: '%2' }, live)).toBe('executing');
    expect(resolveQueuedStatus({ event: 'user-prompt', pane: '%2' }, live)).toBe('thinking');
    expect(resolveQueuedStatus({ event: 'agent-start', pane: '%2' }, live)).toBe('agent');
  });

  it('downgrades an active status to idle when the pane is no longer live', () => {
    expect(resolveQueuedStatus({ event: 'pre-tool', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'agent-start', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'post-tool', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'agent-stop', pane: '%99' }, live)).toBe('idle');
  });

  it('allows active status when there is no pane (cannot verify liveness)', () => {
    expect(resolveQueuedStatus({ event: 'pre-tool' }, live)).toBe('executing');
    expect(resolveQueuedStatus({ event: 'pre-tool', pane: 'not-a-pane' }, live)).toBe('executing');
  });

  it('maps events unaffected by pane liveness', () => {
    expect(resolveQueuedStatus({ event: 'stop', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'session-end', pane: '%99' }, live)).toBe('dead');
    expect(resolveQueuedStatus({ event: 'session-start', pane: '%2' }, live)).toBe('idle');
  });

  it('returns undefined for unknown or missing events', () => {
    expect(resolveQueuedStatus({ event: 'bogus', pane: '%2' }, live)).toBeUndefined();
    expect(resolveQueuedStatus({ pane: '%2' }, live)).toBeUndefined();
  });

  // Regression: a single agentic turn fires pre-tool/post-tool repeatedly —
  // post-tool means one tool call finished, NOT that the turn is done. Mapping
  // it to 'idle' (matching the old, incorrect flat map) made the dashboard
  // flash idle — and falsely trigger the attention banner — on every tool-call
  // boundary mid-turn, even during sessions actively working for 20+ minutes.
  // 'stop' (turn genuinely complete) is the only event that should mean idle.
  // Kept in sync with SessionStateMachine.resolveNext() (state-machine.ts).
  it('maps post-tool and agent-stop to thinking, not idle (turn likely continues)', () => {
    expect(resolveQueuedStatus({ event: 'post-tool', pane: '%2' }, live)).toBe('thinking');
    expect(resolveQueuedStatus({ event: 'agent-stop', pane: '%2' }, live)).toBe('thinking');
  });
});

describe('computeNeedsAttention', () => {
  it('flags running→idle transitions', () => {
    expect(computeNeedsAttention('executing', 'idle')).toBe(true);
    expect(computeNeedsAttention('thinking', 'idle')).toBe(true);
    expect(computeNeedsAttention('agent', 'idle')).toBe(true);
  });

  it('returns undefined when staying idle or transitioning between dead/idle', () => {
    expect(computeNeedsAttention('idle', 'idle')).toBeUndefined();
    expect(computeNeedsAttention('dead', 'idle')).toBeUndefined();
  });

  // Renewed activity is direct evidence someone (or the agent itself) is
  // engaged with the session again — not scoped to the popmux Go action only,
  // since anyone working directly in tmux never triggers Go at all and would
  // otherwise be stuck with a stale banner forever. Any confirmed-running
  // observation clears it (not just a strict idle→running edge): each fresh
  // readOnly picker process only observes one prevStatus→nextStatus step, so
  // a genuine idle→running transition that happened while unobserved would
  // otherwise leave the flag stuck across restarts.
  it('clears the flag whenever the next status is running, regardless of prevStatus', () => {
    expect(computeNeedsAttention('idle', 'executing')).toBe(false);
    expect(computeNeedsAttention('idle', 'thinking')).toBe(false);
    expect(computeNeedsAttention('idle', 'agent')).toBe(false);
    expect(computeNeedsAttention('executing', 'thinking')).toBe(false);
    expect(computeNeedsAttention('agent', 'executing')).toBe(false);
  });
});
