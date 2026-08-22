import { inferClaudePaneBusy, inferPaneBusyForAgent } from '../agents/pane-status.js';
import type { AgentId } from '../agents/types.js';

/**
 * Backwards-compatible Claude pane-title helper.
 *
 * Agent-aware callers should use isPaneBusyForAgent() so Codex's braille
 * spinner/plain-title behavior is interpreted correctly.
 */
export function isPaneBusy(title: string): boolean | undefined {
  return inferClaudePaneBusy(title);
}

export function isPaneBusyForAgent(title: string, agentId: AgentId | undefined): boolean | undefined {
  return inferPaneBusyForAgent(title, agentId);
}
