import { getAgentAdapter } from './registry.js';
export { shellQuote } from './shell.js';
export function buildAgentCommand(input) {
    return getAgentAdapter(input.agentId).buildCommand(input);
}
export function agentWindowName(agentId, projectName) {
    return getAgentAdapter(agentId).windowName(projectName);
}
//# sourceMappingURL=commands.js.map