import { type AgentId } from './types.js';
import type { AgentAdapter } from './adapter.js';
export type { AgentId, LabelSource } from './types.js';
export type { AgentAdapter, AgentCommandInput, AgentDiscoveryContext, AgentStatus } from './adapter.js';
export declare const agents: {
    readonly claude: {
        readonly parseSessionFile: typeof import("./claude/detector.js").parseSessionFile;
        readonly scanProcesses: typeof import("./claude/detector.js").scanProcesses;
        readonly isHeadlessSession: typeof import("./claude/detector.js").isHeadlessSession;
        readonly coldStartScan: typeof import("./claude/status-inferer.js").coldStartScan;
        readonly coldStartLastTask: typeof import("./claude/status-inferer.js").coldStartLastTask;
        readonly coldStartCustomTitle: typeof import("./claude/status-inferer.js").coldStartCustomTitle;
        readonly extractLabel: typeof import("./claude/label-matcher.js").extractLabel;
        readonly projectArtifactsDir: typeof import("./claude/artifacts.js").projectArtifactsDir;
        readonly sessionArtifactPath: typeof import("./claude/artifacts.js").sessionArtifactPath;
        readonly generateContextSummary: typeof import("./claude/summarizer.js").generateContextSummary;
        readonly generateGoalSummary: typeof import("./claude/summarizer.js").generateGoalSummary;
        readonly generateNextSteps: typeof import("./claude/summarizer.js").generateNextSteps;
        readonly generateAllSummaries: typeof import("./claude/summarizer.js").generateAllSummaries;
        readonly clearSummaryCache: typeof import("./claude/summarizer.js").clearSummaryCache;
        readonly startLlmSession: typeof import("./claude/summarizer.js").startLlmSession;
        readonly stopLlmSession: typeof import("./claude/summarizer.js").stopLlmSession;
        readonly getLlmSessionName: typeof import("./claude/summarizer.js").getLlmSessionName;
    };
    readonly codex: {
        discoverLiveSessions: typeof import("./codex/detector.js").discoverLiveCodexSessions;
    };
    readonly adapters: Record<AgentId, AgentAdapter>;
};
export declare function getAgentAdapter(agentId: AgentId | undefined): AgentAdapter;
export declare function listAgentAdapters(): AgentAdapter[];
