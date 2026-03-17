import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';
export class SessionStore extends EventEmitter {
    persistPath;
    sessions = new Map();
    persistTimer = null;
    persistedMeta = new Map(); // pre-loaded from state.json
    constructor(persistPath) {
        super();
        this.persistPath = persistPath;
    }
    getAll() {
        return Array.from(this.sessions.values());
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    getByPid(pid) {
        for (const session of this.sessions.values()) {
            if (session.pid === pid)
                return session;
        }
        return undefined;
    }
    register(session) {
        if (!session.projectName) {
            session.projectName = cwdToSlug(session.cwd);
        }
        // Merge persisted metadata (label, tags, contextSummary) from previous run
        const meta = this.persistedMeta.get(session.sessionId);
        if (meta) {
            if (meta.label !== undefined && !session.label)
                session.label = meta.label;
            if (meta.tags !== undefined && !session.tags)
                session.tags = meta.tags;
            if (meta.contextSummary !== undefined && !session.contextSummary)
                session.contextSummary = meta.contextSummary;
        }
        this.sessions.set(session.sessionId, session);
        this.emit('session-added', session);
        logger.debug('session-store: registered session', { sessionId: session.sessionId, pid: session.pid });
    }
    unregister(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        this.sessions.delete(sessionId);
        this.emit('session-removed', session);
        logger.debug('session-store: unregistered session', { sessionId });
    }
    update(sessionId, patch) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn('session-store: update called for unknown session', { sessionId });
            return;
        }
        Object.assign(session, patch);
        this.emit('session-updated', session);
        logger.debug('session-store: updated session', { sessionId, patch: Object.keys(patch) });
        // If user metadata changed, schedule persist
        if ('label' in patch || 'tags' in patch) {
            this.persist();
        }
    }
    persist() {
        if (this.persistTimer !== null) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => {
            void this._writePersist();
            this.persistTimer = null;
        }, 2000);
    }
    /** Synchronous persist — use at shutdown before process.exit() */
    persistSync() {
        if (this.persistTimer !== null) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        const data = { sessions: {} };
        for (const [id, session] of this.sessions) {
            const entry = {};
            if (session.label !== undefined)
                entry.label = session.label;
            if (session.tags !== undefined)
                entry.tags = session.tags;
            if (session.contextSummary !== undefined)
                entry.contextSummary = session.contextSummary;
            if (Object.keys(entry).length > 0)
                data.sessions[id] = entry;
        }
        try {
            mkdirSync(dirname(this.persistPath), { recursive: true });
            writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
        }
        catch { }
    }
    async _writePersist() {
        const data = { sessions: {} };
        for (const [id, session] of this.sessions) {
            const entry = {};
            if (session.label !== undefined)
                entry.label = session.label;
            if (session.tags !== undefined)
                entry.tags = session.tags;
            if (session.contextSummary !== undefined)
                entry.contextSummary = session.contextSummary;
            if (Object.keys(entry).length > 0) {
                data.sessions[id] = entry;
            }
        }
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
            logger.debug('session-store: persisted state', { path: this.persistPath });
        }
        catch (err) {
            logger.error('session-store: failed to persist state', { err: String(err) });
        }
    }
    restore() {
        try {
            const raw = readFileSync(this.persistPath, 'utf8');
            const data = JSON.parse(raw);
            if (!isPersistFormat(data)) {
                logger.warn('session-store: invalid persist format, skipping restore');
                return;
            }
            for (const [sessionId, entry] of Object.entries(data.sessions)) {
                // Store for later merge when sessions are registered
                this.persistedMeta.set(sessionId, entry);
                // Also apply to already-registered sessions
                const session = this.sessions.get(sessionId);
                if (session) {
                    if (entry.label !== undefined)
                        session.label = entry.label;
                    if (entry.tags !== undefined)
                        session.tags = entry.tags;
                    if (entry.contextSummary !== undefined)
                        session.contextSummary = entry.contextSummary;
                }
            }
            logger.debug('session-store: restored state', { path: this.persistPath });
        }
        catch (err) {
            // Missing file is expected on first run
            const code = err.code;
            if (code !== 'ENOENT') {
                logger.warn('session-store: failed to restore state', { err: String(err) });
            }
        }
    }
}
function isPersistFormat(val) {
    if (typeof val !== 'object' || val === null)
        return false;
    const v = val;
    if (typeof v['sessions'] !== 'object' || v['sessions'] === null)
        return false;
    return true;
}
//# sourceMappingURL=session-store.js.map