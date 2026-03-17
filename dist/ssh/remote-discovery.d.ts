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
    start(pollInterval?: number): void;
    stop(): void;
    private scanAll;
    private scanHost;
}
