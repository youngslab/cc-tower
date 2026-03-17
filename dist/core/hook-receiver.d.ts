import { EventEmitter } from 'node:events';
export declare class HookReceiver extends EventEmitter {
    private socketPath;
    private server;
    constructor(socketPath: string);
    start(): Promise<void>;
    stop(): Promise<void>;
}
