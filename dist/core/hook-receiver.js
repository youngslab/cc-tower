import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import { logger } from '../utils/logger.js';
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
export class HookReceiver extends EventEmitter {
    servers = [];
    socketPaths;
    constructor(socketPath) {
        super();
        const list = Array.isArray(socketPath) ? socketPath : [socketPath];
        // Dedupe + drop empty/falsy entries so duplicate cc-tower.sock paths from
        // legacy callers never bind twice (EADDRINUSE) and so an undefined-y
        // legacy path is silently ignored.
        const seen = new Set();
        this.socketPaths = list.filter((p) => {
            if (!p)
                return false;
            if (seen.has(p))
                return false;
            seen.add(p);
            return true;
        });
    }
    /** Currently bound socket paths (after dedupe). Useful for logging/tests. */
    getSocketPaths() {
        return [...this.socketPaths];
    }
    async start() {
        // Bind sequentially so a legacy bind failure (e.g. permission denied)
        // doesn't take down the primary socket. Errors per-socket are logged but
        // not re-thrown — fewer listeners is degraded but valid.
        for (const socketPath of this.socketPaths) {
            try {
                const server = await this.bindOne(socketPath);
                this.servers.push(server);
            }
            catch (err) {
                logger.warn('hook-receiver: bind failed', { socketPath, error: String(err) });
            }
        }
        if (this.servers.length === 0 && this.socketPaths.length > 0) {
            // Re-throw via the first path so Tower can decide to continue without hooks
            throw new Error(`hook-receiver: failed to bind any socket (${this.socketPaths.join(', ')})`);
        }
    }
    bindOne(socketPath) {
        // Clean up stale socket (idempotent)
        try {
            fs.unlinkSync(socketPath);
        }
        catch { }
        return new Promise((resolve, reject) => {
            const server = net.createServer((conn) => this.handleConnection(conn));
            server.on('error', reject);
            server.listen(socketPath, () => {
                try {
                    fs.chmodSync(socketPath, 0o600);
                }
                catch { }
                resolve(server);
            });
        });
    }
    handleConnection(conn) {
        let buffer = '';
        const processBuffer = () => {
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const event = JSON.parse(line);
                    if (event.event === 'query') {
                        // Query request: emit with conn so Tower can write the response back
                        this.emit('query', conn);
                    }
                    else {
                        this.emit('hook-event', event);
                    }
                }
                catch {
                    logger.warn('hook-receiver: invalid JSON', { line: line.slice(0, 100) });
                }
            }
        };
        conn.on('data', (chunk) => {
            buffer += chunk.toString();
            processBuffer();
        });
        conn.on('end', () => {
            // Flush any remaining data in buffer when connection closes
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer.trim());
                    if (event.event === 'query') {
                        this.emit('query', conn);
                    }
                    else {
                        this.emit('hook-event', event);
                    }
                }
                catch {
                    logger.warn('hook-receiver: invalid JSON', { line: buffer.trim().slice(0, 100) });
                }
                buffer = '';
            }
        });
        conn.on('error', () => { }); // ignore connection errors
    }
    async stop() {
        const closures = this.servers.map((server, i) => new Promise((resolve) => {
            server.close(() => {
                // Best-effort unlink — paths and servers share the same index by construction
                const socketPath = this.socketPaths[i];
                if (socketPath) {
                    try {
                        fs.unlinkSync(socketPath);
                    }
                    catch { }
                }
                resolve();
            });
        }));
        await Promise.all(closures);
        this.servers = [];
    }
}
//# sourceMappingURL=hook-receiver.js.map