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
import { normalizeAgentId, type AgentId, type LabelSource } from './types.js';
import type { AgentAdapter, AgentCommandInput, AgentDiscoveryContext, AgentStatus } from './adapter.js';
export type { AgentId, LabelSource } from './types.js';
export type { AgentAdapter, AgentCommandInput, AgentDiscoveryContext, AgentStatus } from './adapter.js';

function normalizeArgs(args: string | undefined): string {
  return args?.trim() ? ` ${args.trim()}` : '';
}

function safeWindowName(prefix: string, projectName: string): string {
  const safeProject = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${prefix}-${safeProject}`;
}

const claudeAdapter: AgentAdapter = {
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
  buildCommand(input: AgentCommandInput): string {
    const claudeBin = input.claudeBin?.trim();
    const claudeCmd = claudeBin ? shellQuote(claudeBin) : 'claude';
    const claudeArgs = normalizeArgs(input.claudeArgs);
    if (input.resumeId) return `${claudeCmd} --resume ${shellQuote(input.resumeId)}${claudeArgs}`;
    return `${claudeCmd}${claudeArgs}`;
  },
  windowName(projectName: string): string {
    return safeWindowName('claude', projectName);
  },
  inferPaneBusy: inferClaudePaneBusy,
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

const codexAdapter: AgentAdapter = {
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
  buildCommand(input: AgentCommandInput): string {
    if (input.resumeId) return `codex resume ${shellQuote(input.resumeId)} -C ${shellQuote(input.cwd)}`;
    return `codex -C ${shellQuote(input.cwd)}`;
  },
  windowName(projectName: string): string {
    return safeWindowName('codex', projectName);
  },
  inferPaneBusy: inferCodexPaneBusy,
  discoverLiveSessions() {
    return CodexAgent.discoverLiveSessions();
  },
};

const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export const agents = {
  claude: ClaudeAgent,
  codex: CodexAgent,
  adapters,
} as const;

export function getAgentAdapter(agentId: AgentId | undefined): AgentAdapter {
  return adapters[normalizeAgentId(agentId)];
}

export function listAgentAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
