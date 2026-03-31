import { EventEmitter } from 'node:events';
import { RemoteHostConfig } from './remote-commands.js';
export interface RemoteSessionInfo {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    host: string;
    sshTarget: string;
}
/**
 * Discovers Claude Code sessions on remote hosts via SSH.
 */
export declare class RemoteDiscovery extends EventEmitter {
    private hosts;
    private interval;
    private known;
    constructor(hosts: Array<{
        name: string;
        config: RemoteHostConfig;
    }>);
    /**
     * Pre-populate known sessions (e.g. from restored state.json) so the first scan
     * correctly emits session-lost for sessions whose PIDs died (e.g. server reboot).
     */
    addKnown(session: RemoteSessionInfo): void;
    start(pollInterval?: number): void;
    stop(): void;
    private scanAll;
    private scanHost;
}
