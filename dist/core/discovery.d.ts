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
    constructor(config: DiscoveryConfig);
    start(): void;
    stop(): void;
    scanOnce(): Promise<SessionInfo[]>;
    /**
     * Fallback: discover Claude sessions by scanning running processes.
     * Used when ~/.claude/sessions/ is empty (Claude Code >= 2.1.77).
     */
    private scanProcesses;
}
