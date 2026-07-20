import { describe, it, expect } from 'vitest';
import { resolveQueuedStatus } from '../../src/core/queued-status.js';

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
  });

  it('allows active status when there is no pane (cannot verify liveness)', () => {
    expect(resolveQueuedStatus({ event: 'pre-tool' }, live)).toBe('executing');
    expect(resolveQueuedStatus({ event: 'pre-tool', pane: 'not-a-pane' }, live)).toBe('executing');
  });

  it('maps non-active events regardless of pane liveness', () => {
    expect(resolveQueuedStatus({ event: 'post-tool', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'stop', pane: '%99' }, live)).toBe('idle');
    expect(resolveQueuedStatus({ event: 'session-end', pane: '%99' }, live)).toBe('dead');
    expect(resolveQueuedStatus({ event: 'session-start', pane: '%2' }, live)).toBe('idle');
  });

  it('returns undefined for unknown or missing events', () => {
    expect(resolveQueuedStatus({ event: 'bogus', pane: '%2' }, live)).toBeUndefined();
    expect(resolveQueuedStatus({ pane: '%2' }, live)).toBeUndefined();
  });
});
