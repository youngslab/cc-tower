import { EventEmitter } from 'node:events';
/**
 * HookReceiver listens for hook payloads on one or more Unix sockets.
 *
 * Plan v2 §3.4 — dual-socket transition: popmux runs alongside legacy
 * cc-tower hooks for a 14-day deprecation window. Both sockets feed the
 * same SessionStateMachine via the `hook-event` and `query` events; callers
 * cannot tell which socket a payload arrived on (and shouldn't need to).
 *
 * Constructor accepts either a single string (back-compat) or an array of
 * paths. Falsy / duplicate paths are filtered, so callers can always pass
 * `[primary, legacy]` without guarding for a missing legacy path.
 */
export declare class HookReceiver extends EventEmitter {
    private servers;
    private socketPaths;
    constructor(socketPath: string | string[]);
    /** Currently bound socket paths (after dedupe). Useful for logging/tests. */
    getSocketPaths(): string[];
    start(): Promise<void>;
    private bindOne;
    private handleConnection;
    stop(): Promise<void>;
}
