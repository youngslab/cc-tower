import { EventEmitter } from 'node:events';
import { Config } from '../config/defaults.js';
import { DiscoveryEngine } from './discovery.js';
import { SessionStore } from './session-store.js';
import { SessionScanner } from './session-scanner.js';
import { HookReceiver } from './hook-receiver.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { ProcessMonitor } from './process-monitor.js';
import { SessionStateMachine } from './state-machine.js';
import { Summarizer } from './summarizer.js';
import { Notifier } from './notifier.js';
export declare class Tower extends EventEmitter {
    config: Config;
    store: SessionStore;
    /** Lazily scans ~/.claude/projects for all resumable sessions (resume picker). */
    scanner: SessionScanner;
    discovery: DiscoveryEngine;
    hookReceiver: HookReceiver;
    jsonlWatcher: JsonlWatcher;
    processMonitor: ProcessMonitor;
    summarizer: Summarizer;
    notifier: Notifier;
    private stateMachines;
    private remoteStateMachines;
    private hookSidToIdentity;
    private jsonlPaths;
    private stopping;
    private connectionManager;
    private remoteDiscovery;
    private remotePollers;
    private readOnlyDrainTimer;
    private skipHooks;
    private skipColdStart;
    private skipSummary;
    private readOnly;
    private resolver;
    private ledger?;
    constructor(config?: Config, opts?: {
        skipHooks?: boolean;
        skipColdStart?: boolean;
        skipSummary?: boolean;
        readOnly?: boolean;
    });
    private lockFd;
    private acquireLock;
    private getTmuxSessionName;
    private releaseLock;
    start(): Promise<void>;
    /**
     * Read-only hydration: re-create Session entries from persisted state.json
     * without scanning processes, watching JSONLs, or triggering LLM summaries.
     * Used by `--picker --no-cold-start` for sub-second popup spawn.
     *
     * Walks persistedMeta entries (sessionId-keyed) — each one carries enough
     * identity info (cwd, host, pid, sshTarget, startedAt) to reconstruct a
     * Session. Status is forced to 'idle' since we cannot determine liveness
     * without a process scan; summaries come straight from the cached fields.
     */
    private rehydrateFromState;
    private rehydrateNewSessions;
    private readLastUserTask;
    private findPaneForPid;
    private drainEventQueue;
    /**
     * Authoritative correction pass for the readOnly picker path: hook-derived
     * status (drainEventQueue above) depends on every relevant hook firing,
     * arriving in order, and using a name this codebase recognizes — any one
     * failure leaves status stuck wrong indefinitely, in either direction,
     * with no self-healing (unlike the full FSM path's inactivity-check, which
     * itself only helps when the PID has actually died).
     *
     * Claude Code sets the tmux pane title directly from its own process — a
     * live spinner while actively generating, a fixed glyph while idle — so
     * reading it is immune to all of the above. This runs every drain tick and
     * corrects busy↔idle in either direction using the same {statusEvent:true}
     * path, so the attention-banner transition detection applies normally.
     */
    private reconcilePaneTitles;
    /** Split out from reconcilePaneTitles() for direct unit testing (avoids mocking execSync). */
    private applyPaneTitles;
    private applyQueuedEvent;
    /** Full refresh: re-scan discovery, re-register session, then regenerate LLM summaries. */
    refreshSession(sessionId: string): Promise<void>;
    /**
     * Called when session-start hook fires for an already-idle session (e.g. /resume).
     * Claude Code does not update sessions/{pid}.json on /resume, so discovery never emits
     * session-changed and the FSM stays idle→idle (no state-change). This method detects
     * whether a newer JSONL exists (= new conversation was resumed) and refreshes summaries.
     */
    private refreshSessionAfterResume;
    /**
     * Refresh goal + context + nextSteps in a single combined LLM call.
     * Reads earlyContext (head) for goal, recentContext (tail) for context/nextSteps.
     */
    private refreshAllSummaries;
    private refreshGoalSummary;
    private refreshContextSummary;
    private refreshNextSteps;
    private refreshRemoteNextSteps;
    /** Run all three remote summary refreshes concurrently, managing summaryLoading as a unit. */
    private refreshAllRemoteSummaries;
    private refreshRemoteGoalSummary;
    private refreshRemoteContextSummary;
    stop(): Promise<void>;
    private registerSession;
    private registerRemoteSession;
    private startRemoteJsonlPoller;
    /** Immediate cleanup — no dead state, no 30s delay. Used for session migration (clear/resume). */
    private cleanupSession;
    private deregisterSession;
    private resolveIdentity;
    private handleHookEvent;
    private handleJsonlEvent;
    private mapHookToInput;
    getStateMachine(sessionId: string): SessionStateMachine | undefined;
}
