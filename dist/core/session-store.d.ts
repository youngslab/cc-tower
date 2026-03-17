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
    contextSummary?: string;
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
    host: string;
    sshTarget?: string;
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
    restore(): void;
}
