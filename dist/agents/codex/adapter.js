import { inferCodexPaneBusy } from '../pane-status.js';
import { shellQuote } from '../shell.js';
import { prefixedWindowName } from '../adapter.js';
import { CodexAgent } from './index.js';
export const codexAdapter = {
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
//# sourceMappingURL=adapter.js.map