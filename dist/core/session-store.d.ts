import { EventEmitter } from 'node:events';
export interface TurnSummary {
    timestamp: Date;
    transition: string;
    summary: string;
    details?: {
        toolsUsed: string[];
        filesChanged: string[];
        testResult?: {
            passed: number;
            failed: number;
            total: number;
        };
        error?: string;
    };
    tier: 1 | 2 | 3;
}
export interface Session {
    pid: number;
    sessionId: string;
    paneId?: string;
    hasTmux: boolean;
    detectionMode: 'hook' | 'jsonl' | 'process';
    cwd: string;
    projectName: string;
    status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
    lastActivity: Date;
    goalSummary?: string;
    contextSummary?: string;
    nextSteps?: string;
    summaryLoading?: boolean;
    currentActivity?: string;
    currentTask?: string;
    currentSummary?: TurnSummary;
    startedAt: Date;
    messageCount: number;
    toolCallCount: number;
    estimatedCost?: number;
    label?: string;
    tags?: string[];
    favorite?: boolean;
    favoritedAt?: number;
    host: string;
    sshTarget?: string;
    commandPrefix?: string;
    hostOnline?: boolean;
}
export declare class SessionStore extends EventEmitter {
    private persistPath;
    private sessions;
    private persistTimer;
    private persistedMeta;
    constructor(persistPath: string);
    getAll(): Session[];
    get(sessionId: string): Session | undefined;
    getByPid(pid: number): Session | undefined;
    register(session: Session): void;
    unregister(sessionId: string): void;
    update(sessionId: string, patch: Partial<Session>): void;
    persist(): void;
    /** Synchronous persist — use at shutdown before process.exit() */
    persistSync(): void;
    private _writePersist;
    /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
    getPastSessionsByCwd(cwd: string): Array<{
        sessionId: string;
        startedAt: number;
        goalSummary?: string;
        contextSummary?: string;
        nextSteps?: string;
    }>;
    /**
     * Returns past sessions grouped by cwd (most recent per cwd) for the given host.
     * sshTarget undefined = local sessions; sshTarget string = remote sessions for that target.
     * Excludes currently active sessions.
     */
    getPastSessionsByTarget(sshTarget?: string): Array<{
        sessionId: string;
        cwd: string;
        startedAt: number;
        goalSummary?: string;
        contextSummary?: string;
        sshTarget?: string;
    }>;
    /** Returns all past sessions across all hosts, sorted by most recent. */
    getAllPastSessions(): Array<{
        sessionId: string;
        cwd: string;
        startedAt: number;
        goalSummary?: string;
        contextSummary?: string;
        sshTarget?: string;
    }>;
    /** Removes a past session from persistedMeta and rewrites state.json immediately. */
    deletePersistedSession(sessionId: string): void;
    /** Returns all persisted session IDs (keys of persistedMeta). Used to detect remote sessions by key prefix. */
    getPersistedKeys(): string[];
    /** Returns persisted remote sessions (new format with sshTarget) for pre-populating known map before first scan. */
    getRestoredRemoteSessions(): Array<{
        sessionId: string;
        pid: number;
        sshTarget: string;
        cwd: string;
        startedAt: number;
        host: string;
    }>;
    restore(): void;
}
