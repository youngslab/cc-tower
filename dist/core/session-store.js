import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';
import { computeNeedsAttention } from './queued-status.js';
export function sessionIdentity(s) {
    return s.paneId ?? String(s.pid);
}
const META_FIELDS = new Set(['label', 'tags', 'goalSummary', 'contextSummary', 'nextSteps']);
export class SessionStore extends EventEmitter {
    persistPath;
    instances = new Map();
    sessionMeta = new Map();
    persistTimer = null;
    persistedMeta = new Map(); // pre-loaded from state.json
    persistedInstances = new Map(); // v3: keyed by identity (paneId)
    _displayOrder = []; // persisted display order (sessionIds)
    // Transient flag set by dropConversationScopedMeta() and consumed by the next
    // update({ sessionId }) for the same identity. Detects regressions where
    // callers mutate sessionId without dropping conversation-scoped meta first.
    _dropExpected;
    constructor(persistPath) {
        super();
        this.persistPath = persistPath;
    }
    getAll() {
        const result = [];
        for (const instance of this.instances.values()) {
            const meta = this.sessionMeta.get(instance.sessionId);
            result.push({ ...instance, ...(meta ?? {}) });
        }
        return result;
    }
    get(identity) {
        const instance = this.instances.get(identity);
        if (!instance)
            return undefined;
        return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) };
    }
    getByPid(pid) {
        for (const instance of this.instances.values()) {
            if (instance.pid === pid) {
                return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) };
            }
        }
        return undefined;
    }
    getBySessionId(sessionId) {
        for (const instance of this.instances.values()) {
            if (instance.sessionId === sessionId) {
                return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) };
            }
        }
        return undefined;
    }
    rekey(oldIdentity, newIdentity) {
        if (oldIdentity === newIdentity)
            return;
        const instance = this.instances.get(oldIdentity);
        if (!instance)
            return;
        this.instances.delete(oldIdentity);
        this.instances.set(newIdentity, instance);
        const session = this.get(newIdentity);
        this.emit('session-rekeyed', { oldIdentity, newIdentity, session });
        logger.debug('session-store: rekeyed session', { oldIdentity, newIdentity });
    }
    register(session, opts) {
        // Skip duplicate registration (same PID already registered under a different identity)
        const existingByPid = Array.from(this.instances.values()).find(i => i.pid === session.pid && i.pid > 0);
        if (existingByPid) {
            const existingIdentity = sessionIdentity(existingByPid);
            const newIdentity = sessionIdentity(session);
            if (existingIdentity !== newIdentity) {
                logger.warn('session-store: skipping duplicate PID registration', { pid: session.pid, existing: existingIdentity, new: newIdentity });
                return;
            }
        }
        const chosenConversationId = opts?.chosenConversationId;
        if (!session.projectName) {
            session.projectName = cwdToSlug(session.cwd);
        }
        // Merge persisted session metadata (label, tags, summaries) from previous run
        const persisted = this.persistedMeta.get(session.sessionId);
        if (persisted) {
            const existing = this.sessionMeta.get(session.sessionId) ?? {};
            const merged = { ...existing };
            if (persisted.label !== undefined && !merged.label)
                merged.label = persisted.label;
            if (persisted.tags !== undefined && !merged.tags)
                merged.tags = persisted.tags;
            if (persisted.goalSummary !== undefined)
                merged.goalSummary = persisted.goalSummary;
            if (persisted.contextSummary !== undefined && !merged.contextSummary)
                merged.contextSummary = persisted.contextSummary;
            if (persisted.nextSteps !== undefined && !merged.nextSteps)
                merged.nextSteps = persisted.nextSteps;
            this.sessionMeta.set(session.sessionId, merged);
        }
        // Merge persisted instance data (favorite + cached sessionId) by identity
        const identity = sessionIdentity(session);
        const persistedInst = this.persistedInstances.get(identity);
        if (persistedInst) {
            if (persistedInst.needsAttention !== undefined) {
                session.needsAttention = persistedInst.needsAttention;
                session.needsAttentionSetAt = persistedInst.needsAttentionSetAt;
            }
            if (persistedInst.status !== undefined) {
                session.lastPersistedStatus = persistedInst.status;
                // Fresh readOnly picker processes hardcode a naive 'idle' guess when
                // rehydrating from JSONL (no live hook signal yet). If the caller
                // already determined a more specific status (real FSM inference,
                // discovery liveness), don't clobber it — only fill the naive default.
                if (session.status === 'idle') {
                    session.status = persistedInst.status;
                }
            }
            if (persistedInst.favorite !== undefined && !session.favorite) {
                session.favorite = persistedInst.favorite;
                session.favoritedAt = persistedInst.favoritedAt;
            }
            // Use cached sessionId if pid.json is stale (different from last known).
            // Only apply when lastConversationId still matches the JSONL the caller resolved —
            // prevents stale override after /clear (which advances lastConversationId).
            // But skip if another active instance already claims this sessionId (collision from /resume)
            if (persistedInst.lastSessionId && persistedInst.lastSessionId !== session.sessionId) {
                // Claim A fix: persisted hint may override sessionId ONLY when lastConversationId
                // matches the convId the resolver actually chose for THIS registration.
                // If chosenConversationId is undefined, refuse to override (fail-closed).
                const convMatchesCache = persistedInst.lastConversationId !== undefined
                    && chosenConversationId !== undefined
                    && persistedInst.lastConversationId === chosenConversationId;
                const alreadyClaimed = Array.from(this.instances.values()).some(i => i.sessionId === persistedInst.lastSessionId);
                if (!alreadyClaimed && convMatchesCache) {
                    logger.info('session-store: using cached sessionId (pid.json stale)', {
                        identity, stale: session.sessionId.slice(0, 12), cached: persistedInst.lastSessionId.slice(0, 12),
                        chosenConvId: chosenConversationId?.slice(0, 12),
                    });
                    session.sessionId = persistedInst.lastSessionId;
                }
                else {
                    logger.info('session-store: skipping cached sessionId override', {
                        identity, cached: persistedInst.lastSessionId.slice(0, 12),
                        chosenConvId: chosenConversationId?.slice(0, 12),
                        persistedConvId: persistedInst.lastConversationId?.slice(0, 12),
                        reason: alreadyClaimed ? 'already_claimed' : (chosenConversationId === undefined ? 'no_chosen_convid' : 'conv_mismatch'),
                    });
                }
            }
        }
        // Also try legacy: favorite in persistedMeta (v2 state.json) — migrate to instance-level
        if (!session.favorite && persisted?.favorite) {
            session.favorite = persisted.favorite;
            session.favoritedAt = persisted.favoritedAt;
        }
        // Capture any meta fields passed in the session object into sessionMeta
        const { label: _l, tags: _t, goalSummary: _gs, contextSummary: _cs, nextSteps: _ns, ...instancePart } = session;
        const incomingMeta = {};
        if (session.label !== undefined)
            incomingMeta.label = session.label;
        if (session.tags !== undefined)
            incomingMeta.tags = session.tags;
        if (session.goalSummary !== undefined)
            incomingMeta.goalSummary = session.goalSummary;
        if (session.contextSummary !== undefined)
            incomingMeta.contextSummary = session.contextSummary;
        if (session.nextSteps !== undefined)
            incomingMeta.nextSteps = session.nextSteps;
        if (Object.keys(incomingMeta).length > 0) {
            const existing = this.sessionMeta.get(session.sessionId) ?? {};
            this.sessionMeta.set(session.sessionId, { ...existing, ...incomingMeta });
        }
        this.instances.set(sessionIdentity(session), instancePart);
        this.emit('session-added', this.get(sessionIdentity(session)));
        logger.debug('session-store: registered session', { sessionId: session.sessionId, pid: session.pid });
    }
    unregister(identity) {
        const instance = this.instances.get(identity);
        if (!instance)
            return;
        const session = this.get(identity);
        this.instances.delete(identity);
        this.emit('session-removed', session);
        logger.debug('session-store: unregistered session', { sessionId: instance.sessionId });
    }
    update(identity, patch, opts) {
        const instance = this.instances.get(identity);
        if (!instance) {
            logger.warn('session-store: update called for unknown session', { identity });
            return;
        }
        const instancePatch = {};
        const metaPatch = {};
        let hasMeta = false;
        for (const [key, value] of Object.entries(patch)) {
            if (META_FIELDS.has(key)) {
                metaPatch[key] = value;
                hasMeta = true;
            }
            else {
                instancePatch[key] = value;
            }
        }
        // Captured before Object.assign mutates instance.status. On the first
        // statusEvent update after a restore, lastPersistedStatus (disk-recovered)
        // wins; afterwards it's cleared and the live status takes over naturally.
        const prevStatus = instance.lastPersistedStatus ?? instance.status;
        if (Object.keys(instancePatch).length > 0) {
            // Detect sessionId mutation without prior dropConversationScopedMeta call.
            // Callers MUST call dropConversationScopedMeta(identity, newSid) before
            // update({ sessionId }) — see Claim D fix in RCA plan.
            if ('sessionId' in instancePatch && instancePatch.sessionId !== instance.sessionId) {
                if (this._dropExpected !== identity) {
                    logger.warn('session-store: update() called with sessionId change without prior dropConversationScopedMeta', {
                        identity, from: instance.sessionId.slice(0, 12), to: String(instancePatch.sessionId).slice(0, 12),
                    });
                }
                else {
                    this._dropExpected = undefined;
                }
            }
            Object.assign(instance, instancePatch);
        }
        // Attention-banner transition detection — opt-in only (see computeNeedsAttention).
        // Scoped to 'status' in instancePatch so an unrelated statusEvent-flagged patch
        // can never erase the disk-recovered lastPersistedStatus prematurely.
        if (opts?.statusEvent && 'status' in instancePatch) {
            if (!('needsAttention' in instancePatch)) {
                const na = computeNeedsAttention(prevStatus, instancePatch.status);
                if (na !== undefined) {
                    instance.needsAttention = na;
                    instance.needsAttentionSetAt = Date.now();
                }
            }
            instance.lastPersistedStatus = undefined;
        }
        if ('needsAttention' in instancePatch) {
            // Explicit caller decision (e.g. the Go-action clear) — stamp it too, so
            // _buildPersistData() can tell it apart from a stale inherited value a
            // concurrent process never re-derived (see there for why this matters).
            instance.needsAttentionSetAt = Date.now();
        }
        if (hasMeta) {
            const existing = this.sessionMeta.get(instance.sessionId) ?? {};
            this.sessionMeta.set(instance.sessionId, { ...existing, ...metaPatch });
        }
        // Instance-only patches previously never persisted (meta-only condition below).
        // needsAttention/status must survive a process restart, so trigger persist
        // whenever this update touched either.
        if (hasMeta || 'needsAttention' in instancePatch || opts?.statusEvent) {
            this.persist();
        }
        this.emit('session-updated', this.get(identity));
        logger.debug('session-store: updated session', { identity, patch: Object.keys(patch) });
    }
    /** Test-only: flush the debounced persist immediately without bypassing the
     * production trigger logic in update()/updateMeta(). Never call in production code. */
    flushPersist() {
        this.persistSync();
    }
    updateMeta(identity, patch) {
        const instance = this.instances.get(identity);
        if (!instance)
            return;
        const existing = this.sessionMeta.get(instance.sessionId) ?? {};
        this.sessionMeta.set(instance.sessionId, { ...existing, ...patch });
        // label changes must be visible to the next popup open immediately (no 2s debounce)
        if ('label' in patch) {
            this.persistSync();
        }
        else {
            this.persist();
        }
        this.emit('session-updated', this.get(identity));
    }
    setInstanceConversationId(identity, conversationId) {
        const existing = this.persistedInstances.get(identity) ?? {};
        this.persistedInstances.set(identity, { ...existing, lastConversationId: conversationId });
    }
    reassociateMeta(oldSessionId, newSessionId) {
        if (oldSessionId === newSessionId)
            return;
        const meta = this.sessionMeta.get(oldSessionId);
        if (!meta)
            return;
        this.sessionMeta.set(newSessionId, meta);
        this.sessionMeta.delete(oldSessionId);
    }
    /**
     * Per Principle 3 of the cross-contamination RCA: when a conversation rotates
     * (stale-sid hook path, /clear), drop conversation-scoped metadata
     * (label/goalSummary/contextSummary/nextSteps). Identity-scoped fields
     * (favorite/favoritedAt/tags/sshTarget/projectName) are preserved and copied
     * to the new sessionId key. The old key is removed (not merely emptied).
     *
     * Callers MUST invoke this BEFORE update({ sessionId }) on the same identity.
     * Returns null if instance not found or no prior meta existed.
     */
    dropConversationScopedMeta(identity, newSessionId) {
        const instance = this.instances.get(identity);
        if (!instance)
            return null;
        const oldSid = instance.sessionId;
        const meta = this.sessionMeta.get(oldSid);
        // Always set the marker so the next update({ sessionId }) does not warn,
        // even if there was no prior meta.
        this._dropExpected = identity;
        if (!meta)
            return null;
        // Preserve only identity-scoped fields per Principle 3.
        const identityScoped = {};
        if (meta.tags !== undefined)
            identityScoped.tags = meta.tags;
        const droppedKeys = [];
        if (meta.label !== undefined)
            droppedKeys.push('label');
        if (meta.goalSummary !== undefined)
            droppedKeys.push('goalSummary');
        if (meta.contextSummary !== undefined)
            droppedKeys.push('contextSummary');
        if (meta.nextSteps !== undefined)
            droppedKeys.push('nextSteps');
        this.sessionMeta.set(newSessionId, identityScoped);
        this.sessionMeta.delete(oldSid);
        logger.debug('session-store: dropped conversation-scoped meta', { identity, oldSid: oldSid.slice(0, 12), newSid: newSessionId.slice(0, 12), droppedKeys });
        return { droppedKeys, oldSid };
    }
    updateBySessionId(sessionId, patch) {
        const session = this.getBySessionId(sessionId);
        if (!session) {
            logger.warn('session-store: updateBySessionId for unknown session', { sessionId });
            return;
        }
        this.update(sessionIdentity(session), patch);
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
        const data = this._buildPersistData();
        try {
            mkdirSync(dirname(this.persistPath), { recursive: true });
            writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
        }
        catch { }
    }
    async _writePersist() {
        const data = this._buildPersistData();
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
            logger.debug('session-store: persisted state', { path: this.persistPath });
        }
        catch (err) {
            logger.error('session-store: failed to persist state', { err: String(err) });
        }
    }
    /**
     * Re-reads state.json's needsAttention (+ its timestamp) fresh at persist
     * time.
     *
     * Multiple readOnly picker processes can be alive concurrently (a lingering
     * orphan from a popup that didn't fully exit, or two overlapping opens) —
     * each has its own in-memory SessionStore, so one process clearing
     * needsAttention (e.g. the Go action) is invisible to another's memory.
     * Blindly re-persisting our own in-memory snapshot every ~2-3s would
     * silently clobber that clear back to true the next tick — including a
     * clear that happened *after* our own stale in-memory value was set, since
     * a plain "did I ever touch this" flag can't tell old decisions from new
     * ones. _buildPersistData() resolves this with last-write-wins by comparing
     * needsAttentionSetAt timestamps instead.
     */
    _readOnDiskNeedsAttention() {
        const result = new Map();
        try {
            const raw = readFileSync(this.persistPath, 'utf8');
            const data = JSON.parse(raw);
            for (const [identity, inst] of Object.entries(data.instances ?? {})) {
                result.set(identity, { needsAttention: inst.needsAttention === true, needsAttentionSetAt: inst.needsAttentionSetAt });
            }
        }
        catch { }
        return result;
    }
    _buildPersistData() {
        const data = { version: 3, sessions: {}, instances: {}, displayOrder: this._displayOrder };
        const liveSessionIds = new Set();
        const now = Date.now();
        const INSTANCE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (Claim E)
        const onDiskAttention = this._readOnDiskNeedsAttention();
        for (const [identity, instance] of this.instances) {
            if (instance.status === 'dead')
                continue;
            liveSessionIds.add(instance.sessionId);
            const meta = this.sessionMeta.get(instance.sessionId) ?? {};
            const entry = {};
            if (meta.label !== undefined)
                entry.label = meta.label;
            if (meta.tags !== undefined)
                entry.tags = meta.tags;
            if (meta.goalSummary !== undefined)
                entry.goalSummary = meta.goalSummary;
            if (meta.contextSummary !== undefined)
                entry.contextSummary = meta.contextSummary;
            if (meta.nextSteps !== undefined)
                entry.nextSteps = meta.nextSteps;
            if (instance.cwd)
                entry.cwd = instance.cwd;
            if (instance.startedAt)
                entry.startedAt = instance.startedAt.getTime();
            if (instance.sshTarget !== undefined) {
                entry.pid = instance.pid;
                entry.sshTarget = instance.sshTarget;
                entry.host = instance.host;
            }
            data.sessions[instance.sessionId] = entry;
            const instData = {};
            if (instance.favorite) {
                instData.favorite = instance.favorite;
                instData.favoritedAt = instance.favoritedAt;
            }
            // Last-write-wins across concurrent processes: compare timestamps, not
            // "did I ever touch this" — a process holding a stale in-memory true
            // must not out-rank a more recent clear (or vice versa) written by
            // another process after our own decision was made (see
            // _readOnDiskNeedsAttention() for why a plain ownership flag isn't enough).
            const onDisk = onDiskAttention.get(identity);
            const ownSetAt = instance.needsAttentionSetAt ?? -1;
            const diskSetAt = onDisk?.needsAttentionSetAt ?? -1;
            const effectiveNeedsAttention = diskSetAt > ownSetAt ? onDisk.needsAttention : instance.needsAttention === true;
            if (diskSetAt > ownSetAt)
                instance.needsAttentionSetAt = onDisk.needsAttentionSetAt;
            if (effectiveNeedsAttention)
                instData.needsAttention = true;
            if (instance.needsAttentionSetAt !== undefined)
                instData.needsAttentionSetAt = instance.needsAttentionSetAt;
            instance.needsAttention = effectiveNeedsAttention; // keep in-memory/display in sync with what we just persisted
            instData.status = instance.status;
            instData.lastSessionId = instance.sessionId;
            // Claim E: stamp lastSeenAt for every live instance written.
            instData.lastSeenAt = now;
            // Carry over lastConversationId from persistedInstances (set by Tower when JSONL path is resolved)
            const pi = this.persistedInstances.get(identity);
            if (pi?.lastConversationId)
                instData.lastConversationId = pi.lastConversationId;
            data.instances[identity] = instData;
        }
        for (const [sessionId, entry] of this.persistedMeta) {
            if (!liveSessionIds.has(sessionId))
                data.sessions[sessionId] = entry;
        }
        for (const [identity, inst] of this.persistedInstances) {
            if (this.instances.has(identity))
                continue;
            // Claim E: skip non-favorite entries with missing or stale lastSeenAt (>30 days).
            if (!inst.favorite) {
                const lastSeen = inst.lastSeenAt;
                if (lastSeen === undefined || (now - lastSeen) > INSTANCE_TTL_MS) {
                    logger.debug('session-store: evicting stale persisted instance', { identity, lastSeenAt: lastSeen });
                    continue;
                }
            }
            data.instances[identity] = inst;
        }
        return data;
    }
    /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
    getPastSessionsByCwd(cwd) {
        const result = [];
        const activeIds = new Set(this.getAll().map(s => s.sessionId));
        for (const [sessionId, entry] of this.persistedMeta) {
            if (entry.cwd === cwd && !activeIds.has(sessionId)) {
                result.push({
                    sessionId,
                    startedAt: entry.startedAt ?? 0,
                    label: entry.label,
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
        const activeIds = new Set(this.getAll().map(s => s.sessionId));
        const all = [];
        for (const [sessionId, entry] of this.persistedMeta) {
            if (entry.sshTarget !== sshTarget)
                continue;
            if (!entry.cwd)
                continue;
            if (activeIds.has(sessionId))
                continue;
            all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, label: entry.label, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
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
        const activeIds = new Set(this.getAll().map(s => s.sessionId));
        const all = [];
        for (const [sessionId, entry] of this.persistedMeta) {
            if (!entry.cwd)
                continue;
            if (activeIds.has(sessionId))
                continue;
            all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, label: entry.label, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
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
    /**
     * Merge on-disk scanned sessions with state.json metadata for the resume picker.
     * Union by sessionId: scanned (local disk) provides cwd/startedAt for the many
     * sessions popmux never tracked; state.json wins for human metadata
     * (label/goalSummary/contextSummary/sshTarget) and contributes persisted-only
     * sessions not on local disk (e.g. remote). Currently-active sessions are
     * excluded; result is sorted most-recent-first.
     */
    getAllResumableSessions(scanned, scanComplete = false) {
        const merged = new Map();
        // 1. Scanned local-disk sessions — cwd/startedAt from JSONL content; the
        //    `/rename` customTitle becomes the label.
        for (const s of scanned) {
            merged.set(s.sessionId, { sessionId: s.sessionId, cwd: s.cwd, startedAt: s.startedAt, label: s.customTitle });
        }
        // 2. Overlay state.json metadata; add persisted-only (e.g. remote) sessions.
        for (const [sessionId, entry] of this.persistedMeta) {
            const base = merged.get(sessionId);
            // Once a full disk scan has run, a persisted-only local (no sshTarget)
            // entry not found on disk is stale/deleted — hide it rather than
            // resurrecting a session that no longer exists. Remote entries
            // (sshTarget set) can never be confirmed by the local scan, so they
            // always remain eligible.
            if (scanComplete && !base && !entry.sshTarget)
                continue;
            const cwd = base?.cwd ?? entry.cwd;
            if (!cwd)
                continue; // can't resurrect without a cwd
            merged.set(sessionId, {
                sessionId,
                cwd,
                startedAt: base?.startedAt ?? entry.startedAt ?? 0,
                // Scanned customTitle (the JSONL's actual `/rename` record) wins over a
                // persisted state.json label — the latter can be a stale fallback name
                // cached before the label was successfully read (e.g. a late /rename
                // that landed past the scanner's old head-only read window).
                label: base?.label ?? entry.label,
                goalSummary: entry.goalSummary,
                contextSummary: entry.contextSummary,
                sshTarget: entry.sshTarget,
            });
        }
        // 3. Exclude currently-active sessions, sort recent-first.
        const activeIds = new Set(this.getAll().map(s => s.sessionId));
        const out = Array.from(merged.values()).filter(s => !activeIds.has(s.sessionId));
        out.sort((a, b) => b.startedAt - a.startedAt);
        return out;
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
    /** Returns all persisted instance entries [identity/paneId, PersistedInstance]. Used by rehydrateFromState. */
    getPersistedInstanceEntries() {
        return Array.from(this.persistedInstances.entries());
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
            const version = data.version ?? 1;
            const now = Date.now();
            const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
            for (const [sessionId, entry] of Object.entries(data.sessions)) {
                // v2 TTL eviction: skip old non-favorited entries
                if (version >= 2 && entry.startedAt && !entry.favorite && (now - entry.startedAt > maxAge)) {
                    logger.debug('session-store: evicting stale entry', { sessionId, age: Math.round((now - entry.startedAt) / 86400000) + 'd' });
                    continue;
                }
                this.persistedMeta.set(sessionId, entry);
            }
            // v3: Load instance-level data (favorite keyed by identity/paneId)
            const instances = data.instances;
            if (instances) {
                for (const [identity, inst] of Object.entries(instances)) {
                    // Claim E: backfill lastSeenAt for older state.json that didn't write it.
                    // Use startedAt of the matching session entry if available, else now (one-shot grace).
                    if (inst.lastSeenAt === undefined) {
                        const sessEntry = inst.lastSessionId ? data.sessions[inst.lastSessionId] : undefined;
                        inst.lastSeenAt = sessEntry?.startedAt ?? now;
                    }
                    this.persistedInstances.set(identity, inst);
                }
            }
            // v3: Load display order
            const displayOrder = data.displayOrder;
            if (displayOrder)
                this._displayOrder = displayOrder;
            logger.debug('session-store: restored state', { path: this.persistPath, version, instances: this.persistedInstances.size, displayOrder: this._displayOrder.length });
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                logger.warn('session-store: failed to restore state', { err: String(err) });
            }
        }
    }
    getPersistedEntry(sessionId) {
        return this.persistedMeta.get(sessionId);
    }
    get displayOrder() { return this._displayOrder; }
    set displayOrder(order) { this._displayOrder = order; this.persist(); }
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