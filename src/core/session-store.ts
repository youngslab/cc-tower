import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';
import { computeNeedsAttention } from './queued-status.js';
import { normalizeAgentId, type AgentId, type LabelSource } from '../agents/types.js';
import type { ScannedSession } from './session-scanner.js';

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
  agentId?: AgentId;
  pid: number;
  paneId?: string;
  sessionId: string;
  resumeId?: string;
  resumable?: boolean;
  labelSource?: LabelSource;
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
  favoritedAt?: number;        // timestamp when favorited, for stable sort order (undefined once unfavorited)
  favoriteSetAt?: number;      // epoch ms — last-write-wins tiebreak across concurrent processes, see _buildPersistData()
  host?: string;               // 'local' | host name from config
  sshTarget?: string;          // e.g., 'user@192.168.1.10' — undefined for local
  commandPrefix?: string;      // e.g., 'docker exec devenv' — wraps remote commands
  hostOnline?: boolean;        // remote host reachability status
  needsAttention?: boolean;    // running→idle transition happened unobserved (attention banner)
  needsAttentionSetAt?: number; // epoch ms — last-write-wins tiebreak across concurrent processes, see _buildPersistData()
  lastPersistedStatus?: Session['status']; // transition-detection only, restored from disk once, never for display
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
  agentId?: AgentId;
  label?: string;
  labelSource?: LabelSource;
  tags?: string[];
  resumeId?: string;
  resumable?: boolean;
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
  agentId?: AgentId;
  favorite?: boolean;
  favoritedAt?: number;
  favoriteSetAt?: number;  // epoch ms — last-write-wins tiebreak, see _buildPersistData()
  lastSessionId?: string;  // hook-confirmed sessionId — used on cold start when pid.json is stale
  lastConversationId?: string;  // JSONL conversation UUID (filename), updated whenever JSONL path changes
  lastSeenAt?: number;  // epoch ms — used to evict stale entries during persist (Claim E)
  needsAttention?: boolean;  // attention banner flag, survives process restart
  needsAttentionSetAt?: number;  // epoch ms — last-write-wins tiebreak, see _buildPersistData()
  status?: Instance['status'];  // last known status, restored as lastPersistedStatus (never overwrites display status)
}

interface PersistFormat {
  version?: number;  // 1 = legacy, 2 = TTL, 3 = instance-level favorite + displayOrder, 4 = namespaced session keys
  sessions: Record<string, PersistedEntry>;
  instances?: Record<string, PersistedInstance>;  // v3: keyed by identity (paneId)
  displayOrder?: string[];  // v3: ordered list of sessionIds for stable TUI ordering
}

export function sessionIdentity(s: { paneId?: string; pid: number }): string {
  return s.paneId ?? String(s.pid);
}

export function sessionMetaKey(s: { agentId?: AgentId; sessionId: string }): string {
  const agentId = normalizeAgentId(s.agentId);
  return `${agentId}::${s.sessionId}`;
}

function decodePersistedSessionKey(key: string, entry: PersistedEntry): { agentId: AgentId; sessionId: string } {
  if (key.startsWith('claude::')) return { agentId: 'claude', sessionId: key.slice('claude::'.length) };
  if (key.startsWith('codex::')) return { agentId: 'codex', sessionId: key.slice('codex::'.length) };
  return { agentId: normalizeAgentId(entry.agentId), sessionId: key };
}

function canonicalPersistedSessionKey(key: string, entry: PersistedEntry): string {
  const decoded = decodePersistedSessionKey(key, entry);
  return sessionMetaKey(decoded);
}

function legacyClaudeSessionKey(sessionId: string): string {
  return sessionId;
}

function sessionMetaLookupKeys(s: { agentId?: AgentId; sessionId: string }): string[] {
  const agentId = normalizeAgentId(s.agentId);
  const keys = [sessionMetaKey({ agentId, sessionId: s.sessionId })];
  if (agentId === 'claude') keys.push(legacyClaudeSessionKey(s.sessionId));
  return keys;
}

function lookupRawSessionEntry(
  sessions: Record<string, PersistedEntry>,
  agentId: AgentId | undefined,
  sessionId: string,
): PersistedEntry | undefined {
  const normalized = normalizeAgentId(agentId);
  return sessions[sessionMetaKey({ agentId: normalized, sessionId })]
    ?? (normalized === 'claude' ? sessions[legacyClaudeSessionKey(sessionId)] : undefined);
}

const META_FIELDS = new Set<string>(['label', 'tags', 'goalSummary', 'contextSummary', 'nextSteps']);

export class SessionStore extends EventEmitter {
  private instances: Map<string, Instance> = new Map();
  private sessionMeta: Map<string, SessionMeta> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedMeta: Map<string, PersistedEntry> = new Map(); // pre-loaded from state.json
  private persistedInstances: Map<string, PersistedInstance> = new Map(); // v3: keyed by identity (paneId)
  private _displayOrder: string[] = []; // persisted display order (sessionIds)
  // Transient flag set by dropConversationScopedMeta() and consumed by the next
  // update({ sessionId }) for the same identity. Detects regressions where
  // callers mutate sessionId without dropping conversation-scoped meta first.
  private _dropExpected: string | undefined;

  constructor(private persistPath: string) {
    super();
  }

  getAll(): Session[] {
    const result: Session[] = [];
    for (const instance of this.instances.values()) {
      const meta = this.sessionMeta.get(sessionMetaKey(instance));
      result.push({ ...instance, ...(meta ?? {}) });
    }
    return result;
  }

  get(identity: string): Session | undefined {
    const instance = this.instances.get(identity);
    if (!instance) return undefined;
    return { ...instance, ...(this.sessionMeta.get(sessionMetaKey(instance)) ?? {}) } as Session;
  }

  getByPid(pid: number): Session | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pid === pid) {
        return { ...instance, ...(this.sessionMeta.get(sessionMetaKey(instance)) ?? {}) } as Session;
      }
    }
    return undefined;
  }

  getBySessionId(sessionId: string, agentId?: AgentId): Session | undefined {
    for (const instance of this.instances.values()) {
      if (instance.sessionId === sessionId && (agentId === undefined || normalizeAgentId(instance.agentId) === normalizeAgentId(agentId))) {
        return { ...instance, ...(this.sessionMeta.get(sessionMetaKey(instance)) ?? {}) } as Session;
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

  register(session: Session, opts?: { chosenConversationId?: string }): void {
    session.agentId = normalizeAgentId(session.agentId);
    if (session.resumable === undefined) session.resumable = session.agentId === 'claude';
    if (!session.resumeId && session.resumable) session.resumeId = session.sessionId;
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
    let metaKey = sessionMetaKey(session);
    const persisted = this.persistedMeta.get(metaKey) ?? (session.agentId === 'claude' ? this.persistedMeta.get(session.sessionId) : undefined);
    if (persisted) {
      const existing = this.sessionMeta.get(metaKey) ?? {} as SessionMeta;
      const merged: SessionMeta = { ...existing };
      if (persisted.label !== undefined && !merged.label) merged.label = persisted.label;
      if (persisted.tags !== undefined && !merged.tags) merged.tags = persisted.tags;
      if (persisted.goalSummary !== undefined) merged.goalSummary = persisted.goalSummary;
      if (persisted.contextSummary !== undefined && !merged.contextSummary) merged.contextSummary = persisted.contextSummary;
      if (persisted.nextSteps !== undefined && !merged.nextSteps) merged.nextSteps = persisted.nextSteps;
      this.sessionMeta.set(metaKey, merged);
      if (!session.resumeId && persisted.resumeId) session.resumeId = persisted.resumeId;
      if (session.resumable === undefined && persisted.resumable !== undefined) session.resumable = persisted.resumable;
      if (!session.labelSource && persisted.labelSource) session.labelSource = persisted.labelSource;
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
      if (persistedInst.favoriteSetAt !== undefined) {
        session.favoriteSetAt = persistedInst.favoriteSetAt;
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
        const alreadyClaimed = Array.from(this.instances.values()).some(i => i.agentId === session.agentId && i.sessionId === persistedInst.lastSessionId);
        if (!alreadyClaimed && convMatchesCache) {
          logger.info('session-store: using cached sessionId (pid.json stale)', {
            identity, stale: session.sessionId.slice(0, 12), cached: persistedInst.lastSessionId!.slice(0, 12),
            chosenConvId: chosenConversationId?.slice(0, 12),
          });
          session.sessionId = persistedInst.lastSessionId;
          if (session.agentId === 'claude' && session.resumable) session.resumeId = session.sessionId;
          metaKey = sessionMetaKey(session);
        } else {
          logger.info('session-store: skipping cached sessionId override', {
            identity, cached: persistedInst.lastSessionId!.slice(0, 12),
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
    const incomingMeta: Partial<SessionMeta> = {};
    if (session.label !== undefined) incomingMeta.label = session.label;
    if (session.tags !== undefined) incomingMeta.tags = session.tags;
    if (session.goalSummary !== undefined) incomingMeta.goalSummary = session.goalSummary;
    if (session.contextSummary !== undefined) incomingMeta.contextSummary = session.contextSummary;
    if (session.nextSteps !== undefined) incomingMeta.nextSteps = session.nextSteps;
    if (Object.keys(incomingMeta).length > 0) {
      const existing = this.sessionMeta.get(metaKey) ?? {} as SessionMeta;
      this.sessionMeta.set(metaKey, { ...existing, ...incomingMeta });
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

  update(identity: string, patch: Partial<Session>, opts?: { statusEvent?: boolean }): void {
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
        } else {
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
        const na = computeNeedsAttention(prevStatus, instancePatch.status as Session['status']);
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
    if ('favorite' in instancePatch) {
      // Same concurrent-process hazard as needsAttention: a long-lived or
      // orphaned readOnly picker can blindly re-persist its own stale
      // in-memory favorite on its next tick and clobber a toggle another
      // process just made (reproduced live: toggling favorite in one
      // process was silently undone within ~10s by a second one).
      instance.favoriteSetAt = Date.now();
    }

    if (hasMeta) {
      const key = sessionMetaKey(instance);
      const existing = this.sessionMeta.get(key) ?? {} as SessionMeta;
      this.sessionMeta.set(key, { ...existing, ...metaPatch });
    }
    // Instance-only patches previously never persisted (meta-only condition below).
    // needsAttention/status/favorite must survive a process restart, so
    // trigger persist whenever this update touched any of them.
    if (hasMeta || 'needsAttention' in instancePatch || 'favorite' in instancePatch || opts?.statusEvent) {
      this.persist();
    }
    this.emit('session-updated', this.get(identity)!);
    logger.debug('session-store: updated session', { identity, patch: Object.keys(patch) });
  }

  /** Test-only: flush the debounced persist immediately without bypassing the
   * production trigger logic in update()/updateMeta(). Never call in production code. */
  flushPersist(): void {
    this.persistSync();
  }

  updateMeta(identity: string, patch: Partial<SessionMeta>): void {
    const instance = this.instances.get(identity);
    if (!instance) return;
    const key = sessionMetaKey(instance);
    const existing = this.sessionMeta.get(key) ?? {} as SessionMeta;
    this.sessionMeta.set(key, { ...existing, ...patch });
    // label changes must be visible to the next popup open immediately (no 2s debounce)
    if ('label' in patch) {
      this.persistSync();
    } else {
      this.persist();
    }
    this.emit('session-updated', this.get(identity)!);
  }

  setInstanceConversationId(identity: string, conversationId: string): void {
    const existing = this.persistedInstances.get(identity) ?? {};
    this.persistedInstances.set(identity, { ...existing, lastConversationId: conversationId });
  }

  reassociateMeta(oldSessionId: string, newSessionId: string): void {
    if (oldSessionId === newSessionId) return;
    const agentId: AgentId = 'claude';
    const oldKey = sessionMetaKey({ agentId, sessionId: oldSessionId });
    const newKey = sessionMetaKey({ agentId, sessionId: newSessionId });
    const meta = this.sessionMeta.get(oldKey);
    if (!meta) return;
    this.sessionMeta.set(newKey, meta);
    this.sessionMeta.delete(oldKey);
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
  dropConversationScopedMeta(identity: string, newSessionId: string): { droppedKeys: string[]; oldSid: string } | null {
    const instance = this.instances.get(identity);
    if (!instance) return null;
    const oldSid = instance.sessionId;
    const oldKey = sessionMetaKey(instance);
    const newKey = sessionMetaKey({ agentId: instance.agentId, sessionId: newSessionId });
    const meta = this.sessionMeta.get(oldKey);
    // Always set the marker so the next update({ sessionId }) does not warn,
    // even if there was no prior meta.
    this._dropExpected = identity;
    if (!meta) return null;

    // Preserve only identity-scoped fields per Principle 3.
    const identityScoped: SessionMeta = {};
    if (meta.tags !== undefined) identityScoped.tags = meta.tags;

    const droppedKeys: string[] = [];
    if (meta.label !== undefined) droppedKeys.push('label');
    if (meta.goalSummary !== undefined) droppedKeys.push('goalSummary');
    if (meta.contextSummary !== undefined) droppedKeys.push('contextSummary');
    if (meta.nextSteps !== undefined) droppedKeys.push('nextSteps');

    this.sessionMeta.set(newKey, identityScoped);
    this.sessionMeta.delete(oldKey);
    logger.debug('session-store: dropped conversation-scoped meta', { identity, oldSid: oldSid.slice(0, 12), newSid: newSessionId.slice(0, 12), droppedKeys });
    return { droppedKeys, oldSid };
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

  /**
   * Re-reads state.json's concurrency-sensitive instance fields (+ their
   * timestamps) fresh at persist time.
   *
   * Multiple readOnly picker processes can be alive concurrently (a lingering
   * orphan from a popup that didn't fully exit, or two overlapping opens) —
   * each has its own in-memory SessionStore, so one process changing
   * needsAttention (e.g. the Go action) or favorite (toggling 'f') is
   * invisible to another's memory. Blindly re-persisting our own in-memory
   * snapshot every ~2-3s would silently clobber that change back the next
   * tick — including a change that happened *after* our own stale in-memory
   * value was set, since a plain "did I ever touch this" flag can't tell old
   * decisions from new ones. _buildPersistData() resolves this with
   * last-write-wins by comparing each field's *SetAt timestamp instead.
   */
  private _readOnDiskConcurrencySensitiveFields(): Map<string, PersistedInstance> {
    const result = new Map<string, PersistedInstance>();
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { instances?: Record<string, PersistedInstance> };
      for (const [identity, inst] of Object.entries(data.instances ?? {})) {
        result.set(identity, inst);
      }
    } catch {}
    return result;
  }

  private _buildPersistData(): PersistFormat {
    const data: PersistFormat = { version: 4, sessions: {}, instances: {}, displayOrder: this._displayOrder };
    const liveSessionIds = new Set<string>();
    const now = Date.now();
    const INSTANCE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (Claim E)
    const onDiskFields = this._readOnDiskConcurrencySensitiveFields();
    for (const [identity, instance] of this.instances) {
      if (instance.status === 'dead') continue;
      const key = sessionMetaKey(instance);
      liveSessionIds.add(key);
      const meta = this.sessionMeta.get(key) ?? {};
      const entry: PersistedEntry = {};
      entry.agentId = normalizeAgentId(instance.agentId);
      if ((meta as SessionMeta).label !== undefined) entry.label = (meta as SessionMeta).label;
      if (instance.labelSource !== undefined) entry.labelSource = instance.labelSource;
      if ((meta as SessionMeta).tags !== undefined) entry.tags = (meta as SessionMeta).tags;
      if (instance.resumeId !== undefined) entry.resumeId = instance.resumeId;
      if (instance.resumable !== undefined) entry.resumable = instance.resumable;
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
      data.sessions[key] = entry;
      const instData: PersistedInstance = {};
      const onDisk = onDiskFields.get(identity);
      instData.agentId = normalizeAgentId(instance.agentId);
      // Last-write-wins across concurrent processes: compare timestamps, not
      // "did I ever touch this" — a process holding a stale in-memory value
      // must not out-rank a more recent change (or vice versa) written by
      // another process after our own decision was made (see
      // _readOnDiskConcurrencySensitiveFields() for why a plain ownership
      // flag isn't enough).
      const ownAttentionSetAt = instance.needsAttentionSetAt ?? -1;
      const diskAttentionSetAt = onDisk?.needsAttentionSetAt ?? -1;
      const effectiveNeedsAttention = diskAttentionSetAt > ownAttentionSetAt
        ? onDisk!.needsAttention === true
        : instance.needsAttention === true;
      if (diskAttentionSetAt > ownAttentionSetAt) instance.needsAttentionSetAt = onDisk!.needsAttentionSetAt;
      if (effectiveNeedsAttention) instData.needsAttention = true;
      if (instance.needsAttentionSetAt !== undefined) instData.needsAttentionSetAt = instance.needsAttentionSetAt;
      instance.needsAttention = effectiveNeedsAttention; // keep in-memory/display in sync with what we just persisted

      const ownFavoriteSetAt = instance.favoriteSetAt ?? -1;
      const diskFavoriteSetAt = onDisk?.favoriteSetAt ?? -1;
      let effectiveFavorite: boolean;
      let effectiveFavoritedAt: number | undefined;
      if (diskFavoriteSetAt > ownFavoriteSetAt) {
        effectiveFavorite = onDisk!.favorite === true;
        effectiveFavoritedAt = onDisk!.favoritedAt;
        instance.favoriteSetAt = onDisk!.favoriteSetAt;
      } else {
        effectiveFavorite = instance.favorite === true;
        effectiveFavoritedAt = instance.favoritedAt;
      }
      if (effectiveFavorite) { instData.favorite = true; instData.favoritedAt = effectiveFavoritedAt; }
      if (instance.favoriteSetAt !== undefined) instData.favoriteSetAt = instance.favoriteSetAt;
      instance.favorite = effectiveFavorite; // keep in-memory/display in sync with what we just persisted
      instance.favoritedAt = effectiveFavoritedAt;
      instData.status = instance.status;
      instData.lastSessionId = instance.sessionId;
      // Claim E: stamp lastSeenAt for every live instance written.
      instData.lastSeenAt = now;
      // Carry over lastConversationId from persistedInstances (set by Tower when JSONL path is resolved)
      const pi = this.persistedInstances.get(identity);
      if (pi?.lastConversationId) instData.lastConversationId = pi.lastConversationId;
      data.instances![identity] = instData;
    }
    for (const [sessionId, entry] of this.persistedMeta) {
      const key = canonicalPersistedSessionKey(sessionId, entry);
      if (!liveSessionIds.has(key)) data.sessions[key] = entry;
    }
    for (const [identity, inst] of this.persistedInstances) {
      if (this.instances.has(identity)) continue;
      // Claim E: skip non-favorite entries with missing or stale lastSeenAt (>30 days).
      if (!inst.favorite) {
        const lastSeen = inst.lastSeenAt;
        if (lastSeen === undefined || (now - lastSeen) > INSTANCE_TTL_MS) {
          logger.debug('session-store: evicting stale persisted instance', { identity, lastSeenAt: lastSeen });
          continue;
        }
      }
      data.instances![identity] = inst;
    }
    return data;
  }

  /** Returns persisted sessions matching the given cwd, sorted by startedAt desc. */
  getPastSessionsByCwd(cwd: string): Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; nextSteps?: string }> {
    const result: Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; nextSteps?: string }> = [];
    const activeIds = new Set(this.getAll().flatMap(s => sessionMetaLookupKeys(s)));
    for (const [key, entry] of this.persistedMeta) {
      const decoded = decodePersistedSessionKey(key, entry);
      const resumable = entry.resumable ?? decoded.agentId === 'claude';
      if (entry.sshTarget) continue;
      if (entry.cwd === cwd && resumable && !activeIds.has(key)) {
        result.push({
          agentId: decoded.agentId,
          sessionId: decoded.sessionId,
          resumeId: entry.resumeId ?? decoded.sessionId,
          resumable,
          startedAt: entry.startedAt ?? 0,
          label: entry.label,
          labelSource: entry.labelSource,
          goalSummary: entry.goalSummary,
          contextSummary: entry.contextSummary,
          nextSteps: entry.nextSteps,
        });
      }
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Returns local past sessions grouped by cwd (most recent per cwd).
   * Remote target lookups intentionally return empty while remote support is disabled.
   * Excludes currently active sessions.
   */
  getPastSessionsByTarget(sshTarget?: string): Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }> {
    if (sshTarget) return [];
    const activeIds = new Set(this.getAll().flatMap(s => sessionMetaLookupKeys(s)));
    const all: Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }> = [];
    for (const [key, entry] of this.persistedMeta) {
      const decoded = decodePersistedSessionKey(key, entry);
      const resumable = entry.resumable ?? decoded.agentId === 'claude';
      if (entry.sshTarget) continue;
      if (entry.sshTarget !== sshTarget) continue;
      if (!entry.cwd) continue;
      if (!resumable) continue;
      if (activeIds.has(key)) continue;
      all.push({ agentId: decoded.agentId, sessionId: decoded.sessionId, resumeId: entry.resumeId ?? decoded.sessionId, resumable, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, label: entry.label, labelSource: entry.labelSource, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    const byCwd = new Map<string, typeof all[0]>();
    for (const s of all) {
      const key = `${s.agentId}::${s.cwd}`;
      if (!byCwd.has(key)) byCwd.set(key, s);
    }
    return Array.from(byCwd.values());
  }

  /** Returns all past sessions across all hosts, sorted by most recent. */
  getAllPastSessions(): Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }> {
    const activeIds = new Set(this.getAll().flatMap(s => sessionMetaLookupKeys(s)));
    const all: Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }> = [];
    for (const [key, entry] of this.persistedMeta) {
      const decoded = decodePersistedSessionKey(key, entry);
      const resumable = entry.resumable ?? decoded.agentId === 'claude';
      if (entry.sshTarget) continue;
      if (!entry.cwd) continue;
      if (!resumable) continue;
      if (activeIds.has(key)) continue;
      all.push({ agentId: decoded.agentId, sessionId: decoded.sessionId, resumeId: entry.resumeId ?? decoded.sessionId, resumable, cwd: entry.cwd, startedAt: entry.startedAt ?? 0, label: entry.label, labelSource: entry.labelSource, goalSummary: entry.goalSummary, contextSummary: entry.contextSummary, sshTarget: entry.sshTarget });
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    // Deduplicate by (agentId, cwd) — keep most recent
    const seen = new Map<string, typeof all[0]>();
    for (const s of all) {
      const key = `${s.agentId}::${s.cwd}`;
      if (!seen.has(key)) seen.set(key, s);
    }
    return Array.from(seen.values());
  }

  /**
   * Merge on-disk scanned Claude sessions with state.json metadata for the
   * resume picker. Codex sessions are sourced from persisted state only because
   * their metadata comes from the read-only Codex SQLite adapter, not Claude
   * JSONL scans. Currently-active sessions are excluded; result is sorted
   * most-recent-first.
   */
  getAllResumableSessions(scanned: ScannedSession[], scanComplete = false): Array<{ agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }> {
    const merged = new Map<string, { agentId: AgentId; sessionId: string; resumeId?: string; resumable: boolean; cwd: string; startedAt: number; label?: string; labelSource?: LabelSource; goalSummary?: string; contextSummary?: string; sshTarget?: string }>();

    for (const s of scanned) {
      const key = sessionMetaKey({ agentId: 'claude', sessionId: s.sessionId });
      merged.set(key, {
        agentId: 'claude',
        sessionId: s.sessionId,
        resumeId: s.sessionId,
        resumable: true,
        cwd: s.cwd,
        startedAt: s.startedAt,
        label: s.customTitle,
        labelSource: s.customTitle ? 'claude-custom-title' : undefined,
      });
    }

    for (const [key, entry] of this.persistedMeta) {
      const decoded = decodePersistedSessionKey(key, entry);
      const resumable = entry.resumable ?? decoded.agentId === 'claude';
      if (entry.sshTarget) continue;
      if (!resumable) continue;
      const base = merged.get(key);
      // Once a full Claude disk scan has run, a persisted-only local Claude
      // entry not found on disk is stale/deleted. Codex entries cannot be
      // confirmed by that scan, so they remain eligible.
      if (scanComplete && decoded.agentId === 'claude' && !base) continue;
      const cwd = base?.cwd ?? entry.cwd;
      if (!cwd) continue;
      merged.set(key, {
        agentId: decoded.agentId,
        sessionId: decoded.sessionId,
        resumeId: entry.resumeId ?? base?.resumeId ?? decoded.sessionId,
        resumable,
        cwd,
        startedAt: base?.startedAt ?? entry.startedAt ?? 0,
        label: base?.label ?? entry.label,
        labelSource: base?.labelSource ?? entry.labelSource,
        goalSummary: entry.goalSummary,
        contextSummary: entry.contextSummary,
        sshTarget: entry.sshTarget,
      });
    }

    const activeIds = new Set(this.getAll().flatMap(s => sessionMetaLookupKeys(s)));
    const out = Array.from(merged.entries())
      .filter(([key]) => !activeIds.has(key))
      .map(([, value]) => value);
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  /** Removes a past session from persistedMeta and rewrites state.json immediately. */
  deletePersistedSession(sessionId: string, agentId?: AgentId): void {
    const keys = agentId
      ? [sessionMetaKey({ agentId, sessionId })]
      : [sessionId, `claude::${sessionId}`, `codex::${sessionId}`];
    for (const key of keys) this.persistedMeta.delete(key);
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { sessions: Record<string, unknown> };
      for (const key of keys) delete data.sessions[key];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {}
  }

  /** Returns all persisted instance entries [identity/paneId, PersistedInstance]. Used by rehydrateFromState. */
  getPersistedInstanceEntries(): Array<[string, PersistedInstance]> {
    return Array.from(this.persistedInstances.entries());
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
        const decoded = decodePersistedSessionKey(sessionId, entry);
        entry.agentId = decoded.agentId;
        if (entry.resumable === undefined) entry.resumable = decoded.agentId === 'claude';
        if (entry.resumeId === undefined && entry.resumable) entry.resumeId = decoded.sessionId;
        // v2 TTL eviction: skip old non-favorited entries
        if (version >= 2 && entry.startedAt && !entry.favorite && (now - entry.startedAt > maxAge)) {
          logger.debug('session-store: evicting stale entry', { sessionId, age: Math.round((now - entry.startedAt) / 86400000) + 'd' });
          continue;
        }
        this.persistedMeta.set(sessionMetaKey(decoded), entry);
      }
      // v3: Load instance-level data (favorite keyed by identity/paneId)
      const instances = (data as { instances?: Record<string, PersistedInstance> }).instances;
      if (instances) {
        for (const [identity, inst] of Object.entries(instances)) {
          inst.agentId = normalizeAgentId(inst.agentId);
          // Claim E: backfill lastSeenAt for older state.json that didn't write it.
          // Use startedAt of the matching session entry if available, else now (one-shot grace).
          if (inst.lastSeenAt === undefined) {
            const sessEntry = inst.lastSessionId ? lookupRawSessionEntry(data.sessions, inst.agentId, inst.lastSessionId) : undefined;
            inst.lastSeenAt = sessEntry?.startedAt ?? now;
          }
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

  getPersistedEntry(sessionId: string, agentId: AgentId = 'claude'): PersistedEntry | undefined {
    return this.persistedMeta.get(sessionMetaKey({ agentId, sessionId }))
      ?? (agentId === 'claude' ? this.persistedMeta.get(legacyClaudeSessionKey(sessionId)) : undefined);
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
