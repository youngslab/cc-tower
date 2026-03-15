import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tower integration test — validates the orchestration of all core components
// These tests will be filled in after all W2 modules are implemented

describe('Tower', () => {
  it.todo('starts all components in correct order');
  it.todo('performs cold start: scan sessions → restore state → start watchers');
  it.todo('wires hook events to state machines');
  it.todo('wires JSONL events to state machines for non-hook sessions');
  it.todo('registers new sessions discovered during runtime');
  it.todo('unregisters sessions when PID dies');
  it.todo('persists store on stop');
  it.todo('cleans up all resources on stop');
});
