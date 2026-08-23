import { inferCodexPaneBusy } from '../pane-status.js';
import { shellQuote } from '../shell.js';
import { prefixedWindowName, type AgentAdapter, type AgentCommandInput } from '../adapter.js';
import { CodexAgent } from './index.js';

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  shortBadge: 'X',
  capabilities: {
    hooks: false,
    resume: true,
    remote: false,
    summaries: true,
    jsonl: false,
    sqlite: true,
  },
  buildCommand(input: AgentCommandInput): string {
    if (input.resumeId) return `codex resume ${shellQuote(input.resumeId)} -C ${shellQuote(input.cwd)}`;
    return `codex -C ${shellQuote(input.cwd)}`;
  },
  windowName(projectName: string): string {
    return prefixedWindowName('codex', projectName);
  },
  inferPaneBusy: inferCodexPaneBusy,
  defaultResumeId(info) {
    return info.resumeId;
  },
  defaultResumable(info) {
    return Boolean(info.resumeId && !info.sessionId.startsWith('codex-proc-'));
  },
  discoverLiveSessions() {
    return CodexAgent.discoverLiveSessions();
  },
};
