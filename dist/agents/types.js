export function normalizeAgentId(value) {
    return value === 'codex' ? 'codex' : 'claude';
}
export function agentLabel(agentId) {
    return normalizeAgentId(agentId) === 'codex' ? 'Codex' : 'Claude';
}
export function agentBadge(agentId) {
    return normalizeAgentId(agentId) === 'codex' ? '[Codex]' : '[Claude]';
}
export function agentShortBadge(agentId) {
    return normalizeAgentId(agentId) === 'codex' ? 'Ⓧ' : 'Ⓒ';
}
//# sourceMappingURL=types.js.map