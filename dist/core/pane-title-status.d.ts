import type { AgentId } from '../agents/types.js';
/**
 * Backwards-compatible Claude pane-title helper.
 *
 * Agent-aware callers should use isPaneBusyForAgent() so Codex's braille
 * spinner/plain-title behavior is interpreted correctly.
 */
export declare function isPaneBusy(title: string): boolean | undefined;
export declare function isPaneBusyForAgent(title: string, agentId: AgentId | undefined): boolean | undefined;
