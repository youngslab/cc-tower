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
    private hookSidToSessionId;
    private jsonlPaths;
    private stopping;
    private connectionManager;
    private remoteDiscovery;
    private remotePollers;
    private skipHooks;
    constructor(config?: Config, opts?: {
        skipHooks?: boolean;
    });
    private lockFd;
    private acquireLock;
    private releaseLock;
    start(): Promise<void>;
    /** Refresh all LLM summaries for a specific session. */
    refreshSession(sessionId: string): Promise<void>;
    private refreshGoalSummary;
    private refreshContextSummary;
    private refreshNextSteps;
    private refreshRemoteGoalSummary;
    private refreshRemoteContextSummary;
    stop(): Promise<void>;
    private registerSession;
    private registerRemoteSession;
    private startRemoteJsonlPoller;
    /** Immediate cleanup — no dead state, no 30s delay. Used for session migration (clear/resume). */
    private cleanupSession;
    private deregisterSession;
    private resolveSessionId;
    private resolveSessionIdByCwd;
    private handleHookEvent;
    private handleJsonlEvent;
    private mapHookToInput;
    getStateMachine(sessionId: string): SessionStateMachine | undefined;
}
