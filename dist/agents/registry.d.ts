export declare const agents: {
    readonly claude: {
        readonly parseSessionFile: typeof import("./claude/detector.js").parseSessionFile;
        readonly scanProcesses: typeof import("./claude/detector.js").scanProcesses;
        readonly isHeadlessSession: typeof import("./claude/detector.js").isHeadlessSession;
        readonly coldStartScan: typeof import("./claude/status-inferer.js").coldStartScan;
        readonly coldStartLastTask: typeof import("./claude/status-inferer.js").coldStartLastTask;
        readonly coldStartCustomTitle: typeof import("./claude/status-inferer.js").coldStartCustomTitle;
        readonly extractLabel: typeof import("./claude/label-matcher.js").extractLabel;
        readonly generateContextSummary: typeof import("./claude/summarizer.js").generateContextSummary;
        readonly generateGoalSummary: typeof import("./claude/summarizer.js").generateGoalSummary;
        readonly generateNextSteps: typeof import("./claude/summarizer.js").generateNextSteps;
        readonly clearSummaryCache: typeof import("./claude/summarizer.js").clearSummaryCache;
        readonly startLlmSession: typeof import("./claude/summarizer.js").startLlmSession;
        readonly stopLlmSession: typeof import("./claude/summarizer.js").stopLlmSession;
        readonly getLlmSessionName: typeof import("./claude/summarizer.js").getLlmSessionName;
    };
};
export type AgentId = keyof typeof agents;
