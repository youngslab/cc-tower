import { inferClaudePaneBusy } from '../pane-status.js';
import { shellQuote } from '../shell.js';
import { normalizeTrailingArgs, prefixedWindowName, type AgentAdapter, type AgentCommandInput, type AgentDiscoveryContext, type AgentStatus } from '../adapter.js';
import { ClaudeAgent } from './index.js';

export const claudeAdapter: AgentAdapter = {
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
  buildCommand(input: AgentCommandInput): string {
    const claudeBin = input.claudeBin?.trim();
    const claudeCmd = claudeBin ? shellQuote(claudeBin) : 'claude';
    const claudeArgs = normalizeTrailingArgs(input.claudeArgs);
    if (input.resumeId) return `${claudeCmd} --resume ${shellQuote(input.resumeId)}${claudeArgs}`;
    return `${claudeCmd}${claudeArgs}`;
  },
  windowName(projectName: string): string {
    return prefixedWindowName('claude', projectName);
  },
  inferPaneBusy: inferClaudePaneBusy,
  sessionArtifactPath(input) {
    return ClaudeAgent.sessionArtifactPath(input);
  },
  sessionArtifactDir(input) {
    return ClaudeAgent.projectArtifactsDir(input);
  },
  parseSessionFile(filePath: string) {
    return ClaudeAgent.parseSessionFile(filePath);
  },
  isHeadlessSession(sessionsDir: string, pid: number) {
    return ClaudeAgent.isHeadlessSession(sessionsDir, pid);
  },
  coldStartStatus(sessionArtifactPath: string): AgentStatus {
    return ClaudeAgent.coldStartScan(sessionArtifactPath);
  },
  readLastTask(sessionArtifactPath: string) {
    return ClaudeAgent.coldStartLastTask(sessionArtifactPath);
  },
  extractLabel(sessionArtifactPath: string) {
    return ClaudeAgent.extractLabel(sessionArtifactPath);
  },
  clearSummaryCache(sessionId: string) {
    ClaudeAgent.clearSummaryCache(sessionId);
  },
  startLlmSession() {
    return ClaudeAgent.startLlmSession();
  },
  stopLlmSession() {
    return ClaudeAgent.stopLlmSession();
  },
  generateAllSummaries(sessionId: string, earlyMessages: string, recentMessages: string) {
    return ClaudeAgent.generateAllSummaries(sessionId, earlyMessages, recentMessages);
  },
  generateGoalSummary(sessionId: string, earlyMessages: string) {
    return ClaudeAgent.generateGoalSummary(sessionId, earlyMessages);
  },
  generateContextSummary(sessionId: string, recentMessages: string) {
    return ClaudeAgent.generateContextSummary(sessionId, recentMessages);
  },
  generateNextSteps(sessionId: string, recentMessages: string) {
    return ClaudeAgent.generateNextSteps(sessionId, recentMessages);
  },
  discoverLiveSessions(context?: AgentDiscoveryContext) {
    const claudeDir = context?.claudeDir;
    const used = context?.usedSessionIdsByCwd;
    if (!claudeDir || !used) return [];
    return ClaudeAgent.scanProcesses(claudeDir, used).map(info => ({
      ...info,
      agentId: 'claude' as const,
      resumable: true,
      resumeId: info.sessionId,
    }));
  },
};
