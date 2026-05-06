import { EventEmitter } from 'node:events';
export interface SessionInfo {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    host?: string;
    sshTarget?: string;
}
export interface DiscoveryConfig {
    scan_interval: number;
    claude_dir: string;
}
export declare class DiscoveryEngine extends EventEmitter {
    private config;
    private interval;
    private known;
    private hookLocked;
    constructor(config: DiscoveryConfig);
    start(): void;
    /** Update known sessionId for a PID — prevents discovery from overriding hook corrections */
    updateKnown(pid: number, sessionId: string): void;
    stop(): void;
    scanOnce(): Promise<SessionInfo[]>;
    /**
     * Fallback path: ask the claude agent to scan running processes, then
     * apply the same emit-and-track bookkeeping as the file-based path.
     */
    private scanProcessesViaAgent;
}
