/**
 * ClaudeAgent — namespace bundle for all Claude-specific logic.
 *
 * Phase A1 (pivot v2) goal: isolate Claude's idiosyncrasies so additional
 * agents (codex, gemini) can be added without touching `src/core/`.
 *
 * No interface yet — second concrete implementation will drive extraction
 * (2-instances rule). For now this is just an organized re-export surface.
 */
import { parseSessionFile, scanProcesses, isHeadlessSession } from './detector.js';
import { coldStartScan, coldStartLastTask, coldStartCustomTitle, } from './status-inferer.js';
import { extractLabel } from './label-matcher.js';
import { generateContextSummary, generateGoalSummary, generateNextSteps, clearSummaryCache, startLlmSession, stopLlmSession, getLlmSessionName, } from './summarizer.js';
export const ClaudeAgent = {
    // detector
    parseSessionFile,
    scanProcesses,
    isHeadlessSession,
    // status-inferer
    coldStartScan,
    coldStartLastTask,
    coldStartCustomTitle,
    // label-matcher
    extractLabel,
    // summarizer
    generateContextSummary,
    generateGoalSummary,
    generateNextSteps,
    clearSummaryCache,
    startLlmSession,
    stopLlmSession,
    getLlmSessionName,
};
//# sourceMappingURL=index.js.map