import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import { logger } from '../utils/logger.js';
export class HookReceiver extends EventEmitter {
    socketPath;
    server = null;
    constructor(socketPath) {
        super();
        this.socketPath = socketPath;
    }
    async start() {
        // Clean up stale socket
        try {
            fs.unlinkSync(this.socketPath);
        }
        catch { }
        return new Promise((resolve, reject) => {
            this.server = net.createServer((conn) => {
                let buffer = '';
                const processBuffer = () => {
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const event = JSON.parse(line);
                            this.emit('hook-event', event);
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
                            this.emit('hook-event', event);
                        }
                        catch {
                            logger.warn('hook-receiver: invalid JSON', { line: buffer.trim().slice(0, 100) });
                        }
                        buffer = '';
                    }
                });
                conn.on('error', () => { }); // ignore connection errors
            });
            this.server.on('error', reject);
            this.server.listen(this.socketPath, () => resolve());
        });
    }
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    try {
                        fs.unlinkSync(this.socketPath);
                    }
                    catch { }
                    this.server = null;
                    resolve();
                });
            });
        }
    }
}
//# sourceMappingURL=hook-receiver.js.map