/**
 * Agent registry — single import surface for all per-agent modules.
 *
 * The adapter layer keeps platform-specific behavior (discovery, commands,
 * pane-title status, capabilities) behind a common boundary. Legacy namespace
 * exports (`agents.claude.*`) stay available while Tower/UI migrate to the
 * adapter methods.
 */
import { ClaudeAgent } from './claude/index.js';
import { claudeAdapter } from './claude/adapter.js';
import { CodexAgent } from './codex/index.js';
import { codexAdapter } from './codex/adapter.js';
import { normalizeAgentId } from './types.js';
const adapters = {
    claude: claudeAdapter,
    codex: codexAdapter,
};
export const agents = {
    claude: ClaudeAgent,
    codex: CodexAgent,
    adapters,
};
export function getAgentAdapter(agentId) {
    return adapters[normalizeAgentId(agentId)];
}
export function listAgentAdapters() {
    return Object.values(adapters);
}
//# sourceMappingURL=registry.js.map