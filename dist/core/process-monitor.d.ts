import { EventEmitter } from 'node:events';
export interface ProcessState {
    alive: boolean;
    childCount: number;
}
export declare class ProcessMonitor extends EventEmitter {
    private intervals;
    checkOnce(pid: number): Promise<ProcessState>;
    startPolling(pid: number, interval?: number): void;
    stopPolling(pid: number): void;
    stopAll(): void;
}
