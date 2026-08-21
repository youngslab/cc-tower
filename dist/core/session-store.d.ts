import { EventEmitter } from 'node:events';
import type { ScannedSession } from './session-scanner.js';
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
export interface Instance {
    pid: number;
    paneId?: string;
    sessionId: string;
    hasTmux: boolean;
    detectionMode: 'hook' | 'jsonl' | 'process';
    cwd: string;
    projectName: string;
    status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
    lastActivity: Date;
    currentActivity?: string;
    currentTask?: string;
    currentSummary?: TurnSummary;
    startedAt: Date;
    messageCount: number;
    toolCallCount: number;
    estimatedCost?: number;
    summaryLoading?: boolean;
    favorite?: boolean;
    favoritedAt?: number;
    host?: string;
    sshTarget?: string;
    commandPrefix?: string;
    hostOnline?: boolean;
    needsAttention?: boolean;
    needsAttentionSetAt?: number;
    lastPersistedStatus?: Session['status'];
}
export interface SessionMeta {
    label?: string;
    tags?: string[];
    goalSummary?: string;
    contextSummary?: string;
    nextSteps?: string;
}
export type Session = Instance & SessionMeta;
interface PersistedEntry {
    label?: string;
    tags?: string[];
    favorite?: boolean;
    favoritedAt?: number;
    goalSummary?: string;
    contextSummary?: string;
    nextSteps?: string;
    host?: string;
    pid?: number;
    sshTarget?: string;
    cwd?: string;
    startedAt?: number;
}
interface PersistedInstance {
    favorite?: boolean;
    favoritedAt?: number;
    lastSessionId?: string;
    lastConversationId?: string;
    lastSeenAt?: number;
    needsAttention?: boolean;
    needsAttentionSetAt?: number;
    status?: Instance['status'];
}
export declare function sessionIdentity(s: {
    paneId?: string;
    pid: number;
}): string;
export declare class SessionStore extends EventEmitter {
    private persistPath;
    private instances;
    private sessionMeta;
    private persistTimer;
    private persistedMeta;
    private persistedInstances;
    private _displayOrder;
    private _dropExpected;
    constructor(persistPath: string);
    getAll(): Session[];
    get(identity: string): Session | undefined;
    getByPid(pid: number): Session | undefined;
    getBySessionId(sessionId: string): Session | undefined;
    rekey(oldIdentity: string, newIdentity: string): void;
    register(session: Session, opts?: {
        chosenConversationId?: string;
    }): void;
    unregister(identity: string): void;
    update(identity: string, patch: Partial<Session>, opts?: {
        statusEvent?: boolean;
    }): void;
    /** Test-only: flush the debounced persist immediately without bypassing the
     * production trigger logic in update()/updateMeta(). Never call in production code. */
    flushPersist(): void;
    updateMeta(identity: string, patch: Partial<SessionMeta>): void;
    setInstanceConversationId(identity: string, conversationId: string): void;
    reassociateMeta(oldSessionId: string, newSessionId: string): void;
    /**
     * Per Principle 3 of the cross-contamination RCA: when a conversation rotates
     * (stale-sid hook path, /clear), drop conversation-scoped metadata
     * (label/goalSummary/contextSummary/nextSteps). Identity-scoped fields
     * (favorite/favoritedAt/tags/sshTarget/projectName) are preserved and copied
     * to the new sessionId key. The old key is removed (not merely emptied).
     *
     * Callers MUST invoke this BEFORE update({ sessionId }) on the same identity.
     * Returns null if instance not found or no prior meta existed.
     */
    dropConversationScopedMeta(identity: string, newSessionId: string): {
        droppedKeys: string[];
        oldSid: string;
    } | null;
    updateBySessionId(sessionId: string, patch: Partial<Session>): void;
    persist(): void;
    /** Synchronous persist — use at shutdown before process.exit() */
    persistSync(): void;
    private _writePersist;
    /**
     * Re-reads state.json's needsAttention (+ its timestamp) fresh at persist
     * time.
     *
     * Multiple readOnly picker processes can be alive concurrently (a lingering
     * orphan from a popup that didn't fully exit, or two overlapping opens) —
     * each has its own in-memory SessionStore, so one process clearing
     * needsAttention (e.g. the Go action) is invisible to another's memory.
     * Blindly re-persisting our own in-memory snapshot every ~2-3s would
     * silently clobber that clear back to true the next tick — including a
     * clear that happened *after* our own stale in-memory value was set, since
     * a plain "did I ever touch this" flag can't tell old decisions from new
     * ones. _buildPersistData() resolves this with last-write-wins by comparing
     * needsAttentionSetAt timestamps instead.
     */
    private _readOnDiskNeedsAttention;
    private _buildPersistData;
    /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
    getPastSessionsByCwd(cwd: string): Array<{
        sessionId: string;
        startedAt: number;
        label?: string;
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
        label?: string;
        goalSummary?: string;
        contextSummary?: string;
        sshTarget?: string;
    }>;
    /** Returns all past sessions across all hosts, sorted by most recent. */
    getAllPastSessions(): Array<{
        sessionId: string;
        cwd: string;
        startedAt: number;
        label?: string;
        goalSummary?: string;
        contextSummary?: string;
        sshTarget?: string;
    }>;
    /**
     * Merge on-disk scanned sessions with state.json metadata for the resume picker.
     * Union by sessionId: scanned (local disk) provides cwd/startedAt for the many
     * sessions popmux never tracked; state.json wins for human metadata
     * (label/goalSummary/contextSummary/sshTarget) and contributes persisted-only
     * sessions not on local disk (e.g. remote). Currently-active sessions are
     * excluded; result is sorted most-recent-first.
     */
    getAllResumableSessions(scanned: ScannedSession[], scanComplete?: boolean): Array<{
        sessionId: string;
        cwd: string;
        startedAt: number;
        label?: string;
        goalSummary?: string;
        contextSummary?: string;
        sshTarget?: string;
    }>;
    /** Removes a past session from persistedMeta and rewrites state.json immediately. */
    deletePersistedSession(sessionId: string): void;
    /** Returns all persisted session IDs (keys of persistedMeta). Used to detect remote sessions by key prefix. */
    getPersistedKeys(): string[];
    /** Returns all persisted instance entries [identity/paneId, PersistedInstance]. Used by rehydrateFromState. */
    getPersistedInstanceEntries(): Array<[string, PersistedInstance]>;
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
    getPersistedEntry(sessionId: string): PersistedEntry | undefined;
    get displayOrder(): string[];
    set displayOrder(order: string[]);
}
export {};
