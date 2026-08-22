import { inferClaudePaneBusy, inferPaneBusyForAgent } from '../agents/pane-status.js';
/**
 * Backwards-compatible Claude pane-title helper.
 *
 * Agent-aware callers should use isPaneBusyForAgent() so Codex's braille
 * spinner/plain-title behavior is interpreted correctly.
 */
export function isPaneBusy(title) {
    return inferClaudePaneBusy(title);
}
export function isPaneBusyForAgent(title, agentId) {
    return inferPaneBusyForAgent(title, agentId);
}
//# sourceMappingURL=pane-title-status.js.map