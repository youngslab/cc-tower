/**
 * ClaudeAgent — namespace bundle for all Claude-specific logic.
 *
 * Phase A1 (pivot v2) goal: isolate Claude's idiosyncrasies so additional
 * agents (codex, gemini) can be added without touching `src/core/`.
 *
 * No interface yet — second concrete implementation will drive extraction
 * (2-instances rule). For now this is just an organized re-export surface.
 */
import { parseSessionFile, scanProcesses, isHeadlessSession, type ClaudeSessionInfo } from './detector.js';
import { coldStartScan, coldStartLastTask, coldStartCustomTitle, type SessionState } from './status-inferer.js';
import { extractLabel } from './label-matcher.js';
import { generateContextSummary, generateGoalSummary, generateNextSteps, clearSummaryCache, startLlmSession, stopLlmSession, getLlmSessionName } from './summarizer.js';
export declare const ClaudeAgent: {
    readonly parseSessionFile: typeof parseSessionFile;
    readonly scanProcesses: typeof scanProcesses;
    readonly isHeadlessSession: typeof isHeadlessSession;
    readonly coldStartScan: typeof coldStartScan;
    readonly coldStartLastTask: typeof coldStartLastTask;
    readonly coldStartCustomTitle: typeof coldStartCustomTitle;
    readonly extractLabel: typeof extractLabel;
    readonly generateContextSummary: typeof generateContextSummary;
    readonly generateGoalSummary: typeof generateGoalSummary;
    readonly generateNextSteps: typeof generateNextSteps;
    readonly clearSummaryCache: typeof clearSummaryCache;
    readonly startLlmSession: typeof startLlmSession;
    readonly stopLlmSession: typeof stopLlmSession;
    readonly getLlmSessionName: typeof getLlmSessionName;
};
export type { ClaudeSessionInfo, SessionState };
