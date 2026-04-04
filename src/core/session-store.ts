import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';

export interface TurnSummary {
  timestamp: Date;
  transition: string;
  summary: string;
  details?: {
    toolsUsed: string[];
    filesChanged: string[];
    testResult?: { passed: number; failed: number; total: number };
    error?: string;
  };
  tier: 1 | 2 | 3;
}

export interface Instance {
  pid: number;
  paneId?: string;
  sessionId: string;
  hasTmux: boolean;
  detectionMode: 'hook' | 'jsonl' | 'process';
  cwd: string;
  projectName: string;
  status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
  lastActivity: Date;
  currentActivity?: string;    // Tier1+2: 지금 하고 있는 일 (Detail View)
  currentTask?: string;        // 마지막 user 메시지 (raw, fallback용)
  currentSummary?: TurnSummary;
  startedAt: Date;
  messageCount: number;
  toolCallCount: number;
  estimatedCost?: number;
  summaryLoading?: boolean;    // LLM 요약 대기 중
  favorite?: boolean;          // instance-level: survives session changes
  favoritedAt?: number;        // timestamp when favorited, for stable sort order
  host?: string;               // 'local' | host name from config
  sshTarget?: string;          // e.g., 'user@192.168.1.10' — undefined for local
  commandPrefix?: string;      // e.g., 'docker exec devenv' — wraps remote commands
  hostOnline?: boolean;        // remote host reachability status
}

export interface SessionMeta {
  label?: string;
  tags?: string[];
  goalSummary?: string;        // LLM-generated: 세션 전체 목표 (generated once from early messages)
  contextSummary?: string;     // LLM-generated: 최근 작업 방향 (Dashboard TASK)
  nextSteps?: string;          // LLM-generated: suggested next action on idle
}

export type Session = Instance & SessionMeta;

// PersistedEntry is a superset of SessionMeta — it includes identity/runtime fields
// (sessionId, cwd, projectName, host, pid, startedAt) needed for restore lookups,
// plus all SessionMeta fields. The in-memory sessionMeta map uses SessionMeta only.
interface PersistedEntry {
  label?: string;
  tags?: string[];
  favorite?: boolean;
  favoritedAt?: number;
  goalSummary?: string;
  contextSummary?: string;
  nextSteps?: string;
  host?: string;
  pid?: number;
  sshTarget?: string;
  cwd?: string;
  startedAt?: number;
}

interface PersistedInstance {
  favorite?: boolean;
  favoritedAt?: number;
  lastSessionId?: string;  // hook-confirmed sessionId — used on cold start when pid.json is stale
}

interface PersistFormat {
  version?: number;  // 1 = legacy (no field), 2 = current, 3 = instance-level favorite + displayOrder
  sessions: Record<string, PersistedEntry>;
  instances?: Record<string, PersistedInstance>;  // v3: keyed by identity (paneId)
  displayOrder?: string[];  // v3: ordered list of sessionIds for stable TUI ordering
}

export function sessionIdentity(s: { paneId?: string; pid: number }): string {
  return s.paneId ?? String(s.pid);
}

const META_FIELDS = new Set<string>(['label', 'tags', 'goalSummary', 'contextSummary', 'nextSteps']);

export class SessionStore extends EventEmitter {
  private instances: Map<string, Instance> = new Map();
  private sessionMeta: Map<string, SessionMeta> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedMeta: Map<string, PersistedEntry> = new Map(); // pre-loaded from state.json
  private persistedInstances: Map<string, PersistedInstance> = new Map(); // v3: keyed by identity (paneId)
  private _displayOrder: string[] = []; // persisted display order (sessionIds)

  constructor(private persistPath: string) {
    super();
  }

  getAll(): Session[] {
    const result: Session[] = [];
    for (const instance of this.instances.values()) {
      const meta = this.sessionMeta.get(instance.sessionId);
      result.push({ ...instance, ...(meta ?? {}) });
    }
    return result;
  }

  get(identity: string): Session | undefined {
    const instance = this.instances.get(identity);
    if (!instance) return undefined;
    return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) } as Session;
  }

  getByPid(pid: number): Session | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pid === pid) {
        return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) } as Session;
      }
    }
    return undefined;
  }

  getBySessionId(sessionId: string): Session | undefined {
    for (const instance of this.instances.values()) {
      if (instance.sessionId === sessionId) {
        return { ...instance, ...(this.sessionMeta.get(instance.sessionId) ?? {}) } as Session;
      }
    }
    return undefined;
  }

  rekey(oldIdentity: string, newIdentity: string): void {
    if (oldIdentity === newIdentity) return;
    const instance = this.instances.get(oldIdentity);
    if (!instance) return;
    this.instances.delete(oldIdentity);
    this.instances.set(newIdentity, instance);
    const session = this.get(newIdentity)!;
    this.emit('session-rekeyed', { oldIdentity, newIdentity, session });
    logger.debug('session-store: rekeyed session', { oldIdentity, newIdentity });
  }

  register(session: Session): void {
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
    if (!session.projectName) {
      session.projectName = cwdToSlug(session.cwd);
    }
    // Merge persisted session metadata (label, tags, summaries) from previous run
    const persisted = this.persistedMeta.get(session.sessionId);
    if (persisted) {
      const existing = this.sessionMeta.get(session.sessionId) ?? {} as SessionMeta;
      const merged: SessionMeta = { ...existing };
      if (persisted.label !== undefined && !merged.label) merged.label = persisted.label;
      if (persisted.tags !== undefined && !merged.tags) merged.tags = persisted.tags;
      if (persisted.goalSummary !== undefined) merged.goalSummary = persisted.goalSummary;
      if (persisted.contextSummary !== undefined && !merged.contextSummary) merged.contextSummary = persisted.contextSummary;
      if (persisted.nextSteps !== undefined && !merged.nextSteps) merged.nextSteps = persisted.nextSteps;
      this.sessionMeta.set(session.sessionId, merged);
    }
    // Merge persisted instance data (favorite + cached sessionId) by identity
    const identity = sessionIdentity(session);
    const persistedInst = this.persistedInstances.get(identity);
    if (persistedInst) {
      if (persistedInst.favorite !== undefined && !session.favorite) {
        session.favorite = persistedInst.favorite;
        session.favoritedAt = persistedInst.favoritedAt;
      }
      // Use cached sessionId if pid.json is stale (different from last known)
      // But skip if another active instance already claims this sessionId (collision from /resume)
      if (persistedInst.lastSessionId && persistedInst.lastSessionId !== session.sessionId) {
        const alreadyClaimed = Array.from(this.instances.values()).some(i => i.sessionId === persistedInst.lastSessionId);
        if (!alreadyClaimed) {
          logger.info('session-store: using cached sessionId (pid.json stale)', {
            identity, stale: session.sessionId.slice(0, 12), cached: persistedInst.lastSessionId!.slice(0, 12),
          });
          session.sessionId = persistedInst.lastSessionId;
        } else {
          logger.info('session-store: cached sessionId already claimed by another instance, skipping', {
            identity, cached: persistedInst.lastSessionId!.slice(0, 12),
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
    const { label: _l, tags: _t, favorite: _f, favoritedAt: _fa, goalSummary: _gs, contextSummary: _cs, nextSteps: _ns, ...instancePart } = session;
    const incomingMeta: Partial<SessionMeta> = {};
    if (session.label !== undefined) incomingMeta.label = session.label;
    if (session.tags !== undefined) incomingMeta.tags = session.tags;
    if (session.goalSummary !== undefined) incomingMeta.goalSummary = session.goalSummary;
    if (session.contextSummary !== undefined) incomingMeta.contextSummary = session.contextSummary;
    if (session.nextSteps !== undefined) incomingMeta.nextSteps = session.nextSteps;
    if (Object.keys(incomingMeta).length > 0) {
      const existing = this.sessionMeta.get(session.sessionId) ?? {} as SessionMeta;
      this.sessionMeta.set(session.sessionId, { ...existing, ...incomingMeta });
    }
    this.instances.set(sessionIdentity(session), instancePart as Instance);
    this.emit('session-added', this.get(sessionIdentity(session))!);
    logger.debug('session-store: registered session', { sessionId: session.sessionId, pid: session.pid });
  }

  unregister(identity: string): void {
    const instance = this.instances.get(identity);
    if (!instance) return;
    const session = this.get(identity)!;
    this.instances.delete(identity);
    this.emit('session-removed', session);
    logger.debug('session-store: unregistered session', { sessionId: instance.sessionId });
  }

  update(identity: string, patch: Partial<Session>): void {
    const instance = this.instances.get(identity);
    if (!instance) {
      logger.warn('session-store: update called for unknown session', { identity });
      return;
    }

    const instancePatch: Partial<Instance> = {};
    const metaPatch: Partial<SessionMeta> = {};
    let hasMeta = false;

    for (const [key, value] of Object.entries(patch)) {
      if (META_FIELDS.has(key)) {
        (metaPatch as Record<string, unknown>)[key] = value;
        hasMeta = true;
      } else {
        (instancePatch as Record<string, unknown>)[key] = value;
      }
    }

    if (Object.keys(instancePatch).length > 0) {
      Object.assign(instance, instancePatch);
    }
    if (hasMeta) {
      const existing = this.sessionMeta.get(instance.sessionId) ?? {} as SessionMeta;
      this.sessionMeta.set(instance.sessionId, { ...existing, ...metaPatch });
      this.persist();
    }
    this.emit('session-updated', this.get(identity)!);
    logger.debug('session-store: updated session', { identity, patch: Object.keys(patch) });
  }

  updateMeta(identity: string, patch: Partial<SessionMeta>): void {
    const instance = this.instances.get(identity);
    if (!instance) return;
    const existing = this.sessionMeta.get(instance.sessionId) ?? {} as SessionMeta;
    this.sessionMeta.set(instance.sessionId, { ...existing, ...patch });
    this.persist();
    this.emit('session-updated', this.get(identity)!);
  }

  reassociateMeta(oldSessionId: string, newSessionId: string): void {
    if (oldSessionId === newSessionId) return;
    const meta = this.sessionMeta.get(oldSessionId);
    if (!meta) return;
    this.sessionMeta.set(newSessionId, meta);
    this.sessionMeta.delete(oldSessionId);
  }

  updateBySessionId(sessionId: string, patch: Partial<Session>): void {
    const session = this.getBySessionId(sessionId);
    if (!session) {
      logger.warn('session-store: updateBySessionId for unknown session', { sessionId });
      return;
    }
    this.update(sessionIdentity(session), patch);
  }

  persist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      void this._writePersist();
      this.persistTimer = null;
    }, 2000);
  }

  /** Synchronous persist — use at shutdown before process.exit() */
  persistSync(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const data = this._buildPersistData();
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {}
  }

  private async _writePersist(): Promise<void> {
    const data = this._buildPersistData();
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
      logger.debug('session-store: persisted state', { path: this.persistPath });
    } catch (err) {
      logger.error('session-store: failed to persist state', { err: String(err) });
    }
  }

  private _buildPersistData(): PersistFormat {
    const data: PersistFormat = { version: 3, sessions: {}, instances: {}, displayOrder: this._displayOrder };
    const liveSessionIds = new Set<string>();
    for (const [identity, instance] of this.instances) {
      if (instance.status === 'dead') continue;
      liveSessionIds.add(instance.sessionId);
      const meta = this.sessionMeta.get(instance.sessionId) ?? {};
      const entry: PersistedEntry = {};
      if ((meta as SessionMeta).label !== undefined) entry.label = (meta as SessionMeta).label;
      if ((meta as SessionMeta).tags !== undefined) entry.tags = (meta as SessionMeta).tags;
      if ((meta as SessionMeta).goalSummary !== undefined) entry.goalSummary = (meta as SessionMeta).goalSummary;
      if ((meta as SessionMeta).contextSummary !== undefined) entry.contextSummary = (meta as SessionMeta).contextSummary;
      if ((meta as SessionMeta).nextSteps !== undefined) entry.nextSteps = (meta as SessionMeta).nextSteps;
      if (instance.cwd) entry.cwd = instance.cwd;
      if (instance.startedAt) entry.startedAt = instance.startedAt.getTime();
      if (instance.sshTarget !== undefined) {
        entry.pid = instance.pid;
        entry.sshTarget = instance.sshTarget;
        entry.host = instance.host;
      }
      data.sessions[instance.sessionId] = entry;
      const instData: PersistedInstance = {};
      if (instance.favorite) { instData.favorite = instance.favorite; instData.favoritedAt = instance.favoritedAt; }
      instData.lastSessionId = instance.sessionId;
      data.instances![identity] = instData;
    }
    for (const [sessionId, entry] of this.persistedMeta) {
      if (!liveSessionIds.has(sessionId)) data.sessions[sessionId] = entry;
    }
    for (const [identity, inst] of this.persistedInstances) {
      if (!this.instances.has(identity)) data.instances![identity] = inst;
    }
    return data;
  }

  /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
  getPastSessionsByCwd(cwd: string): Array<{ sessionId: string; startedAt: number; goalSummary?: string; contextSummary?: string; nextSteps?: string }> {
    const result: Array<{ sessionId: string; startedAt: number; goalSummary?: string; contextSummary?: string; nextSteps?: string }> = [];
    const activeIds = new Set(this.getAll().map(s => s.sessionId));
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
  getPastSessionsByTarget(sshTarget?: string): Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string; sshTarget?: string }> {
    const activeIds = new Set(this.getAll().map(s => s.sessionId));
    const all: Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string; sshTarget?: string }> = [];
    for (const [sessionId, entry] of this.persistedMeta) {
      if (entry.sshTarget !== sshTarget) continue;
      if (!entry.cwd) continue;
      if (activeIds.has(sessionId)) continue;
      all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    const byCwd = new Map<string, typeof all[0]>();
    for (const s of all) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, s);
    }
    return Array.from(byCwd.values());
  }

  /** Returns all past sessions across all hosts, sorted by most recent. */
  getAllPastSessions(): Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string; sshTarget?: string }> {
    const activeIds = new Set(this.getAll().map(s => s.sessionId));
    const all: Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string; sshTarget?: string }> = [];
    for (const [sessionId, entry] of this.persistedMeta) {
      if (!entry.cwd) continue;
      if (activeIds.has(sessionId)) continue;
      all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    // Deduplicate by (sshTarget, cwd) — keep most recent
    const seen = new Map<string, typeof all[0]>();
    for (const s of all) {
      const key = `${s.sshTarget ?? ''}::${s.cwd}`;
      if (!seen.has(key)) seen.set(key, s);
    }
    return Array.from(seen.values());
  }

  /** Removes a past session from persistedMeta and rewrites state.json immediately. */
  deletePersistedSession(sessionId: string): void {
    this.persistedMeta.delete(sessionId);
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { sessions: Record<string, unknown> };
      delete data.sessions[sessionId];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {}
  }

  /** Returns all persisted session IDs (keys of persistedMeta). Used to detect remote sessions by key prefix. */
  getPersistedKeys(): string[] {
    return Array.from(this.persistedMeta.keys());
  }

  /** Returns persisted remote sessions (new format with sshTarget) for pre-populating known map before first scan. */
  getRestoredRemoteSessions(): Array<{ sessionId: string; pid: number; sshTarget: string; cwd: string; startedAt: number; host: string }> {
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

  restore(): void {
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      if (!isPersistFormat(data)) {
        logger.warn('session-store: invalid persist format, skipping restore');
        return;
      }
      const version = (data as { version?: number }).version ?? 1;
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
      const instances = (data as { instances?: Record<string, PersistedInstance> }).instances;
      if (instances) {
        for (const [identity, inst] of Object.entries(instances)) {
          this.persistedInstances.set(identity, inst);
        }
      }
      // v3: Load display order
      const displayOrder = (data as { displayOrder?: string[] }).displayOrder;
      if (displayOrder) this._displayOrder = displayOrder;
      logger.debug('session-store: restored state', { path: this.persistPath, version, instances: this.persistedInstances.size, displayOrder: this._displayOrder.length });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn('session-store: failed to restore state', { err: String(err) });
      }
    }
  }

  getPersistedEntry(sessionId: string): PersistedEntry | undefined {
    return this.persistedMeta.get(sessionId);
  }

  get displayOrder(): string[] { return this._displayOrder; }
  set displayOrder(order: string[]) { this._displayOrder = order; this.persist(); }
}

function isPersistFormat(val: unknown): val is PersistFormat {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  if (typeof v['sessions'] !== 'object' || v['sessions'] === null) return false;
  return true;
}
