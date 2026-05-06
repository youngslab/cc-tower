import { EventEmitter } from 'node:events';
import { Config } from '../config/defaults.js';
import { DiscoveryEngine } from './discovery.js';
import { SessionStore } from './session-store.js';
import { HookReceiver } from './hook-receiver.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { ProcessMonitor } from './process-monitor.js';
import { SessionStateMachine } from './state-machine.js';
import { Summarizer } from './summarizer.js';
import { Notifier } from './notifier.js';
export declare class Tower extends EventEmitter {
    config: Config;
    store: SessionStore;
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
    private skipHooks;
    private skipColdStart;
    private skipSummary;
    private readOnly;
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
    /** Full refresh: re-scan discovery, re-register session, then regenerate LLM summaries. */
    refreshSession(sessionId: string): Promise<void>;
    /**
     * Renames the tmux session containing the given pane to `claude-{projectName}`.
     * Skips if: session already has the correct name, is the Tower's own session,
     * or already belongs to a different project (starts with "claude-" but differs).
     */
    private ensureTmuxSessionName;
    /**
     * Called when session-start hook fires for an already-idle session (e.g. /resume).
     * Claude Code does not update sessions/{pid}.json on /resume, so discovery never emits
     * session-changed and the FSM stays idle→idle (no state-change). This method detects
     * whether a newer JSONL exists (= new conversation was resumed) and refreshes summaries.
     */
    private refreshSessionAfterResume;
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
