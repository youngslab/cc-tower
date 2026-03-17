import { EventEmitter } from 'node:events';
import { remoteReadSessions } from './remote-commands.js';
import { logger } from '../utils/logger.js';
/**
 * Discovers Claude Code sessions on remote hosts via SSH.
 */
export class RemoteDiscovery extends EventEmitter {
    hosts;
    interval = null;
    known = new Map(); // key: host::sessionId
    constructor(hosts) {
        super();
        this.hosts = hosts;
    }
    start(pollInterval = 5000) {
        if (this.interval)
            return;
        void this.scanAll();
        this.interval = setInterval(() => void this.scanAll(), pollInterval);
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    async scanAll() {
        await Promise.all(this.hosts.map(h => this.scanHost(h.name, h.config)));
    }
    async scanHost(hostName, config) {
        let raw;
        try {
            raw = await remoteReadSessions(config);
        }
        catch (err) {
            logger.debug('remote-discovery: scan failed', { host: hostName, error: String(err) });
            this.emit('host-offline', hostName);
            return;
        }
        this.emit('host-online', hostName);
        // Parse concatenated JSON objects (cat *.json outputs them back to back)
        const sessions = [];
        // Each file is a separate JSON object, split by }{ pattern
        const jsonStrings = raw.replace(/\}\s*\{/g, '}|||{').split('|||');
        for (const str of jsonStrings) {
            try {
                const data = JSON.parse(str.trim());
                if (data['pid'] && data['sessionId'] && data['cwd']) {
                    sessions.push({
                        pid: data['pid'],
                        sessionId: data['sessionId'],
                        cwd: data['cwd'],
                        startedAt: data['startedAt'] ?? Date.now(),
                        host: hostName,
                        sshTarget: config.sshTarget,
                    });
                }
            }
            catch { }
        }
        // Detect new/lost sessions
        const currentKeys = new Set();
        for (const session of sessions) {
            const key = `${hostName}::${session.sessionId}`;
            currentKeys.add(key);
            if (!this.known.has(key)) {
                this.known.set(key, session);
                this.emit('session-found', session);
                logger.debug('remote-discovery: found', { host: hostName, sessionId: session.sessionId });
            }
        }
        // Remove stale sessions for this host
        for (const [key, session] of this.known) {
            if (session.host === hostName && !currentKeys.has(key)) {
                this.known.delete(key);
                this.emit('session-lost', session);
                logger.debug('remote-discovery: lost', { host: hostName, sessionId: session.sessionId });
            }
        }
    }
}
//# sourceMappingURL=remote-discovery.js.map