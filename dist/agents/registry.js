/**
 * Agent registry — single import surface for all per-agent modules.
 *
 * The adapter layer keeps platform-specific behavior (discovery, commands,
 * pane-title status, capabilities) behind a common boundary. Legacy namespace
 * exports (`agents.claude.*`) stay available while Tower/UI migrate to the
 * adapter methods.
 */
import { ClaudeAgent } from './claude/index.js';
import { CodexAgent } from './codex/index.js';
import { shellQuote } from './shell.js';
import { inferClaudePaneBusy, inferCodexPaneBusy } from './pane-status.js';
import { normalizeAgentId } from './types.js';
function normalizeArgs(args) {
    return args?.trim() ? ` ${args.trim()}` : '';
}
function safeWindowName(prefix, projectName) {
    const safeProject = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
    return `${prefix}-${safeProject}`;
}
const claudeAdapter = {
    id: 'claude',
    label: 'Claude',
    shortBadge: 'C',
    capabilities: {
        hooks: true,
        resume: true,
        remote: true,
        summaries: true,
        jsonl: true,
        sqlite: false,
    },
    buildCommand(input) {
        const claudeBin = input.claudeBin?.trim();
        const claudeCmd = claudeBin ? shellQuote(claudeBin) : 'claude';
        const claudeArgs = normalizeArgs(input.claudeArgs);
        if (input.resumeId)
            return `${claudeCmd} --resume ${shellQuote(input.resumeId)}${claudeArgs}`;
        return `${claudeCmd}${claudeArgs}`;
    },
    windowName(projectName) {
        return safeWindowName('claude', projectName);
    },
    inferPaneBusy: inferClaudePaneBusy,
    parseSessionFile(filePath) {
        return ClaudeAgent.parseSessionFile(filePath);
    },
    isHeadlessSession(sessionsDir, pid) {
        return ClaudeAgent.isHeadlessSession(sessionsDir, pid);
    },
    coldStartStatus(sessionArtifactPath) {
        return ClaudeAgent.coldStartScan(sessionArtifactPath);
    },
    readLastTask(sessionArtifactPath) {
        return ClaudeAgent.coldStartLastTask(sessionArtifactPath);
    },
    extractLabel(sessionArtifactPath) {
        return ClaudeAgent.extractLabel(sessionArtifactPath);
    },
    clearSummaryCache(sessionId) {
        ClaudeAgent.clearSummaryCache(sessionId);
    },
    startLlmSession() {
        return ClaudeAgent.startLlmSession();
    },
    stopLlmSession() {
        return ClaudeAgent.stopLlmSession();
    },
    generateAllSummaries(sessionId, earlyMessages, recentMessages) {
        return ClaudeAgent.generateAllSummaries(sessionId, earlyMessages, recentMessages);
    },
    generateGoalSummary(sessionId, earlyMessages) {
        return ClaudeAgent.generateGoalSummary(sessionId, earlyMessages);
    },
    generateContextSummary(sessionId, recentMessages) {
        return ClaudeAgent.generateContextSummary(sessionId, recentMessages);
    },
    generateNextSteps(sessionId, recentMessages) {
        return ClaudeAgent.generateNextSteps(sessionId, recentMessages);
    },
    discoverLiveSessions(context) {
        const claudeDir = context?.claudeDir;
        const used = context?.usedSessionIdsByCwd;
        if (!claudeDir || !used)
            return [];
        return ClaudeAgent.scanProcesses(claudeDir, used).map(info => ({
            ...info,
            agentId: 'claude',
            resumable: true,
            resumeId: info.sessionId,
        }));
    },
};
const codexAdapter = {
    id: 'codex',
    label: 'Codex',
    shortBadge: 'X',
    capabilities: {
        hooks: false,
        resume: true,
        remote: false,
        summaries: false,
        jsonl: false,
        sqlite: true,
    },
    buildCommand(input) {
        if (input.resumeId)
            return `codex resume ${shellQuote(input.resumeId)} -C ${shellQuote(input.cwd)}`;
        return `codex -C ${shellQuote(input.cwd)}`;
    },
    windowName(projectName) {
        return safeWindowName('codex', projectName);
    },
    inferPaneBusy: inferCodexPaneBusy,
    discoverLiveSessions() {
        return CodexAgent.discoverLiveSessions();
    },
};
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