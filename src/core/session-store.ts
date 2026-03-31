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

export interface Session {
  pid: number;
  sessionId: string;
  paneId?: string;
  hasTmux: boolean;
  detectionMode: 'hook' | 'jsonl' | 'process';
  cwd: string;
  projectName: string;
  status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
  lastActivity: Date;
  goalSummary?: string;        // LLM-generated: 세션 전체 목표 (generated once from early messages)
  contextSummary?: string;     // LLM-generated: 최근 작업 방향 (Dashboard TASK)
  nextSteps?: string;          // LLM-generated: suggested next action on idle
  summaryLoading?: boolean;    // LLM 요약 대기 중
  currentActivity?: string;    // Tier1+2: 지금 하고 있는 일 (Detail View)
  currentTask?: string;        // 마지막 user 메시지 (raw, fallback용)
  currentSummary?: TurnSummary;
  startedAt: Date;
  messageCount: number;
  toolCallCount: number;
  estimatedCost?: number;
  label?: string;
  tags?: string[];
  favorite?: boolean;
  favoritedAt?: number;  // timestamp when favorited, for stable sort order
  host: string;           // 'local' | host name from config
  sshTarget?: string;     // e.g., 'user@192.168.1.10' — undefined for local
  commandPrefix?: string; // e.g., 'docker exec devenv' — wraps remote commands
  hostOnline?: boolean;   // remote host reachability status
}

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

interface PersistFormat {
  sessions: Record<string, PersistedEntry>;
}

export class SessionStore extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedMeta: Map<string, PersistedEntry> = new Map(); // pre-loaded from state.json

  constructor(private persistPath: string) {
    super();
  }

  getAll(): Session[] {
    return Array.from(this.sessions.values());
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getByPid(pid: number): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.pid === pid) return session;
    }
    return undefined;
  }

  register(session: Session): void {
    if (!session.projectName) {
      session.projectName = cwdToSlug(session.cwd);
    }
    // Merge persisted metadata (label, tags, contextSummary) from previous run
    const meta = this.persistedMeta.get(session.sessionId);
    if (meta) {
      if (meta.label !== undefined && !session.label) session.label = meta.label;
      if (meta.tags !== undefined && !session.tags) session.tags = meta.tags;
      if (meta.favorite !== undefined && !session.favorite) { session.favorite = meta.favorite; session.favoritedAt = meta.favoritedAt; }
      if (meta.goalSummary !== undefined) session.goalSummary = meta.goalSummary;
      if (meta.contextSummary !== undefined && !session.contextSummary) session.contextSummary = meta.contextSummary;
      if (meta.nextSteps !== undefined && !session.nextSteps) session.nextSteps = meta.nextSteps;
    }
    this.sessions.set(session.sessionId, session);
    this.emit('session-added', session);
    logger.debug('session-store: registered session', { sessionId: session.sessionId, pid: session.pid });
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.emit('session-removed', session);
    logger.debug('session-store: unregistered session', { sessionId });
  }

  update(sessionId: string, patch: Partial<Session>): void {
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
    const data: PersistFormat = { sessions: {} };
    for (const [id, session] of this.sessions) {
      if (session.status === 'dead') continue;
      const entry: PersistedEntry = {};
      if (session.label !== undefined) entry.label = session.label;
      if (session.tags !== undefined) entry.tags = session.tags;
      if (session.favorite !== undefined) entry.favorite = session.favorite;
      if (session.favoritedAt !== undefined) entry.favoritedAt = session.favoritedAt;
      if (session.goalSummary !== undefined) entry.goalSummary = session.goalSummary;
      if (session.contextSummary !== undefined) entry.contextSummary = session.contextSummary;
      if (session.nextSteps !== undefined) entry.nextSteps = session.nextSteps;
      if (session.cwd) entry.cwd = session.cwd;
      if (session.startedAt) entry.startedAt = session.startedAt.getTime();
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
    } catch {}
  }

  private async _writePersist(): Promise<void> {
    const data: PersistFormat = { sessions: {} };
    for (const [id, session] of this.sessions) {
      if (session.status === 'dead') continue;
      const entry: PersistedEntry = {};
      if (session.label !== undefined) entry.label = session.label;
      if (session.tags !== undefined) entry.tags = session.tags;
      if (session.favorite !== undefined) entry.favorite = session.favorite;
      if (session.favoritedAt !== undefined) entry.favoritedAt = session.favoritedAt;
      if (session.goalSummary !== undefined) entry.goalSummary = session.goalSummary;
      if (session.contextSummary !== undefined) entry.contextSummary = session.contextSummary;
      if (session.nextSteps !== undefined) entry.nextSteps = session.nextSteps;
      if (session.cwd) entry.cwd = session.cwd;
      if (session.startedAt) entry.startedAt = session.startedAt.getTime();
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
    } catch (err) {
      logger.error('session-store: failed to persist state', { err: String(err) });
    }
  }

  /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
  getPastSessionsByCwd(cwd: string): Array<{ sessionId: string; startedAt: number; goalSummary?: string; contextSummary?: string; nextSteps?: string }> {
    const result: Array<{ sessionId: string; startedAt: number; goalSummary?: string; contextSummary?: string; nextSteps?: string }> = [];
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
  getPastSessionsByTarget(sshTarget?: string): Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string }> {
    const activeIds = new Set(this.sessions.keys());
    const all: Array<{ sessionId: string; cwd: string; startedAt: number; goalSummary?: string; contextSummary?: string }> = [];
    for (const [sessionId, entry] of this.persistedMeta) {
      if (entry.sshTarget !== sshTarget) continue;
      if (!entry.cwd) continue;
      if (activeIds.has(sessionId)) continue;
      all.push({ sessionId, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary });
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    const byCwd = new Map<string, typeof all[0]>();
    for (const s of all) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, s);
    }
    return Array.from(byCwd.values());
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
      for (const [sessionId, entry] of Object.entries(data.sessions)) {
        // Store for later merge when sessions are registered
        this.persistedMeta.set(sessionId, entry);
        // Also apply to already-registered sessions
        const session = this.sessions.get(sessionId);
        if (session) {
          if (entry.label !== undefined) session.label = entry.label;
          if (entry.tags !== undefined) session.tags = entry.tags;
          if (entry.favorite !== undefined) { session.favorite = entry.favorite; session.favoritedAt = entry.favoritedAt; }
          if (entry.goalSummary !== undefined) session.goalSummary = entry.goalSummary;
          if (entry.contextSummary !== undefined) session.contextSummary = entry.contextSummary;
          if (entry.nextSteps !== undefined) session.nextSteps = entry.nextSteps;
        }
      }
      logger.debug('session-store: restored state', { path: this.persistPath });
    } catch (err) {
      // Missing file is expected on first run
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn('session-store: failed to restore state', { err: String(err) });
      }
    }
  }
}

function isPersistFormat(val: unknown): val is PersistFormat {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  if (typeof v['sessions'] !== 'object' || v['sessions'] === null) return false;
  return true;
}
