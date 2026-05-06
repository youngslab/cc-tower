import { EventEmitter } from 'node:events';
import { SessionStore } from './session-store.js';
import { StateChange } from './state-machine.js';
import { Config } from '../config/defaults.js';
export declare class Notifier extends EventEmitter {
    private config;
    private store;
    private lastNotification;
    private focused;
    constructor(config: Config['notifications'], store: SessionStore);
    setFocused(focused: boolean): void;
    onStateChange(change: StateChange): void;
    private shouldNotify;
    private notify;
}
