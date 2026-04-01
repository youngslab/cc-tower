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
            if (meta.favorite !== undefined && !session.favorite) {
                session.favorite = meta.favorite;
                session.favoritedAt = meta.favoritedAt;
            }
            if (meta.goalSummary !== undefined)
                session.goalSummary = meta.goalSummary;
            if (meta.contextSummary !== undefined && !session.contextSummary)
                session.contextSummary = meta.contextSummary;
            if (meta.nextSteps !== undefined && !session.nextSteps)
                session.nextSteps = meta.nextSteps;
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
        // If metadata or summaries changed, schedule persist
        if ('label' in patch || 'tags' in patch || 'favorite' in patch ||
            'goalSummary' in patch || 'contextSummary' in patch || 'nextSteps' in patch) {
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
            if (session.status === 'dead')
                continue;
            const entry = {};
            if (session.label !== undefined)
                entry.label = session.label;
            if (session.tags !== undefined)
                entry.tags = session.tags;
            if (session.favorite !== undefined)
                entry.favorite = session.favorite;
            if (session.favoritedAt !== undefined)
                entry.favoritedAt = session.favoritedAt;
            if (session.goalSummary !== undefined)
                entry.goalSummary = session.goalSummary;
            if (session.contextSummary !== undefined)
                entry.contextSummary = session.contextSummary;
            if (session.nextSteps !== undefined)
                entry.nextSteps = session.nextSteps;
            if (session.cwd)
                entry.cwd = session.cwd;
            if (session.startedAt)
                entry.startedAt = session.startedAt.getTime();
            if (session.sshTarget !== undefined) {
                entry.pid = session.pid;
                entry.sshTarget = session.sshTarget;
                entry.host = session.host;
            }
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
            if (session.status === 'dead')
                continue;
            const entry = {};
            if (session.label !== undefined)
                entry.label = session.label;
            if (session.tags !== undefined)
                entry.tags = session.tags;
            if (session.favorite !== undefined)
                entry.favorite = session.favorite;
            if (session.favoritedAt !== undefined)
                entry.favoritedAt = session.favoritedAt;
            if (session.goalSummary !== undefined)
                entry.goalSummary = session.goalSummary;
            if (session.contextSummary !== undefined)
                entry.contextSummary = session.contextSummary;
            if (session.nextSteps !== undefined)
                entry.nextSteps = session.nextSteps;
            if (session.cwd)
                entry.cwd = session.cwd;
            if (session.startedAt)
                entry.startedAt = session.startedAt.getTime();
            if (session.sshTarget !== undefined) {
                entry.pid = session.pid;
                entry.sshTarget = session.sshTarget;
                entry.host = session.host;
            }
            data.sessions[id] = entry;
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
    /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
    getPastSessionsByCwd(cwd) {
        const result = [];
        const activeIds = new Set(this.sessions.keys());
        for (const [sessionId, entry] of this.persistedMeta) {
            if (entry.cwd === cwd && !activeIds.has(sessionId)) {
                result.push({
                    sessionId,
                    startedAt: entry.startedAt ?? 0,
                    goalSummary: entry.goalSummary,
                    contextSummary: entry.contextSummary,
                    nextSteps: entry.nextSteps,
                });
            }
        }
        return result.sort((a, b) => b.startedAt - a.startedAt);
    }
    /**
     * Returns past sessions grouped by cwd (most recent per cwd) for the given host.
     * sshTarget undefined = local sessions; sshTarget string = remote sessions for that target.
     * Excludes currently active sessions.
     */
    getPastSessionsByTarget(sshTarget) {
        const activeIds = new Set(this.sessions.keys());
        const all = [];
        for (const [sessionId, entry] of this.persistedMeta) {
            if (entry.sshTarget !== sshTarget)
                continue;
            if (!entry.cwd)
                continue;
            if (activeIds.has(sessionId))
                continue;
            all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
        }
        all.sort((a, b) => b.startedAt - a.startedAt);
        const byCwd = new Map();
        for (const s of all) {
            if (!byCwd.has(s.cwd))
                byCwd.set(s.cwd, s);
        }
        return Array.from(byCwd.values());
    }
    /** Returns all past sessions across all hosts, sorted by most recent. */
    getAllPastSessions() {
        const activeIds = new Set(this.sessions.keys());
        const all = [];
        for (const [sessionId, entry] of this.persistedMeta) {
            if (!entry.cwd)
                continue;
            if (activeIds.has(sessionId))
                continue;
            all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
        }
        all.sort((a, b) => b.startedAt - a.startedAt);
        // Deduplicate by (sshTarget, cwd) — keep most recent
        const seen = new Map();
        for (const s of all) {
            const key = `${s.sshTarget ?? ''}::${s.cwd}`;
            if (!seen.has(key))
                seen.set(key, s);
        }
        return Array.from(seen.values());
    }
    /** Removes a past session from persistedMeta and rewrites state.json immediately. */
    deletePersistedSession(sessionId) {
        this.persistedMeta.delete(sessionId);
        try {
            const raw = readFileSync(this.persistPath, 'utf8');
            const data = JSON.parse(raw);
            delete data.sessions[sessionId];
            writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
        }
        catch { }
    }
    /** Returns all persisted session IDs (keys of persistedMeta). Used to detect remote sessions by key prefix. */
    getPersistedKeys() {
        return Array.from(this.persistedMeta.keys());
    }
    /** Returns persisted remote sessions (new format with sshTarget) for pre-populating known map before first scan. */
    getRestoredRemoteSessions() {
        const result = [];
        for (const [sessionId, entry] of this.persistedMeta) {
            if (entry.sshTarget && entry.pid && entry.cwd && entry.host) {
                result.push({
                    sessionId,
                    pid: entry.pid,
                    sshTarget: entry.sshTarget,
                    cwd: entry.cwd,
                    startedAt: entry.startedAt ?? 0,
                    host: entry.host,
                });
            }
        }
        return result;
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
                    if (entry.favorite !== undefined) {
                        session.favorite = entry.favorite;
                        session.favoritedAt = entry.favoritedAt;
                    }
                    if (entry.goalSummary !== undefined)
                        session.goalSummary = entry.goalSummary;
                    if (entry.contextSummary !== undefined)
                        session.contextSummary = entry.contextSummary;
                    if (entry.nextSteps !== undefined)
                        session.nextSteps = entry.nextSteps;
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