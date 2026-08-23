import { inferClaudePaneBusy } from '../pane-status.js';
import { shellQuote } from '../shell.js';
import { normalizeTrailingArgs, prefixedWindowName } from '../adapter.js';
import { ClaudeAgent } from './index.js';
export const claudeAdapter = {
    id: 'claude',
    label: 'Claude',
    shortBadge: 'C',
    capabilities: {
        hooks: true,
        resume: true,
        remote: false,
        summaries: true,
        jsonl: true,
        sqlite: false,
    },
    buildCommand(input) {
        const claudeBin = input.claudeBin?.trim();
        const claudeCmd = claudeBin ? shellQuote(claudeBin) : 'claude';
        const claudeArgs = normalizeTrailingArgs(input.claudeArgs);
        if (input.resumeId)
            return `${claudeCmd} --resume ${shellQuote(input.resumeId)}${claudeArgs}`;
        return `${claudeCmd}${claudeArgs}`;
    },
    windowName(projectName) {
        return prefixedWindowName('claude', projectName);
    },
    inferPaneBusy: inferClaudePaneBusy,
    defaultResumeId(info) {
        return info.sessionId;
    },
    defaultResumable() {
        return true;
    },
    sessionArtifactPath(input) {
        return ClaudeAgent.sessionArtifactPath(input);
    },
    sessionArtifactDir(input) {
        return ClaudeAgent.projectArtifactsDir(input);
    },
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
//# sourceMappingURL=adapter.js.map