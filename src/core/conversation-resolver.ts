/**
 * ConversationResolver — authoritative Instance → Conversation (JSONL) mapping.
 *
 * Replaces the 9+ scattered fs.readdirSync / JSONL-selection fallbacks in tower.ts
 * with a single stateful service that owns a claim table.
 *
 * Design decisions:
 * - claim() is synchronous and atomic (Node.js single-threaded event loop guarantee).
 *   Callers do NOT supply claimedByOthers — the resolver's internal table is the authority.
 * - Disk evidence at hook time (mtime ordering) is authoritative.
 * - Sticky rule: never rotate away from the current JSONL unless the candidate is
 *   ≥100ms newer and unclaimed by another identity.
 * - Fail-closed on ambiguity: return confidence:'none' rather than guess.
 * - skipContentProbes: picker/readOnly mode skips last-line I/O; ties → fail-closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type HookEvent =
  | 'session-start'
  | 'user-prompt'
  | 'pre-tool'
  | 'post-tool'
  | 'stop'
  | 'rehydrate'
  | 'unknown';

export type ResolverConfidence = 'high' | 'medium' | 'low' | 'none';

export type ResolverReason =
  | 'initial_assignment'
  | 'mtime_newest_unclaimed'
  | 'last_line_timestamp_match'
  | 'sticky_kept'
  | 'candidate_claimed_by_sibling'
  | 'confidence_too_low'
  | 'no_candidates'
  | 'persisted_overruled_by_mtime';

export interface ResolverInput {
  /** tmux pane ID if known, e.g. '%5' */
  paneId?: string;
  /** Claude process PID */
  pid: number;
  /** Working directory of the Claude process */
  cwd: string;
  /** CLAUDE_SESSION_ID env var (immutable, equals initial JSONL basename) */
  hookSid: string;
  /** Hook event timestamp in ms */
  hookTimestampMs: number;
  /** Type of hook event that triggered this resolution */
  hookEvent: HookEvent;
  /** Currently tracked conversationId for this instance (if any) */
  currentConversationId?: string;
  /** Hint: persisted lastConversationId from state.json (treated as weak hint) */
  persistedConversationId?: string;
}

export interface ResolverResult {
  conversationId: string | null;
  confidence: ResolverConfidence;
  reason: ResolverReason;
  evidence: {
    jsonlPath: string | null;
    mtimeMs: number | null;
    size: number | null;
    lastLineTimestampMs: number | null;
  };
  /** Whether the conversationId changed from the caller's currentConversationId */
  rotated: boolean;
  /** Observability: the persisted hint that was seen by claim() (if any). */
  persistedConvIdSeen?: string;
  /** Observability: secondary rejection reason (e.g. persisted hint overruled). */
  claimRejectedReason?: string;
}

export interface ConversationResolverOptions {
  /**
   * Skip last-line content probes (for picker/readOnly/skipColdStart mode).
   * In this mode, same-mtime ties return confidence:'none' (fail-closed).
   */
  skipContentProbes?: boolean;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface CandidateFile {
  convId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

interface DirCache {
  files: CandidateFile[];
  expiresAt: number;
}

const DIR_CACHE_TTL_MS = 200;
const STICKY_MIN_DELTA_MS = 100;
const HOOK_WRITE_WINDOW_MS = 2000;
const MEDIUM_CONFIDENCE_WINDOW_MS = 60_000;
const LAST_LINE_PROBE_BYTES = 4096;
const HOOK_TIMESTAMP_TOLERANCE_MS = 5000;

// ─── ConversationResolver ─────────────────────────────────────────────────────

export class ConversationResolver {
  private readonly claudeDir: string;
  private readonly opts: ConversationResolverOptions;

  /** convId → identity that claimed it */
  private readonly claimTable = new Map<string, string>();
  /** identity → convId it currently holds */
  private readonly identityTable = new Map<string, string>();

  /** Per-slug directory listing cache */
  private readonly dirCache = new Map<string, DirCache>();

  constructor(claudeDir: string, opts: ConversationResolverOptions = {}) {
    this.claudeDir = claudeDir;
    this.opts = opts;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Atomically resolve and claim a JSONL for the given instance.
   * If a better candidate is found and passes the sticky rule, the claim table
   * is updated and rotated=true is returned.
   */
  claim(input: ResolverInput): ResolverResult {
    const identity = input.paneId ?? String(input.pid);
    const current = this.identityTable.get(identity) ?? input.currentConversationId;

    const candidates = this.scanCandidates(input.cwd, identity);

    if (candidates.length === 0) {
      return this.makeResult(null, 'none', 'no_candidates', null, current);
    }

    // 1. Try exact match: hookSid.jsonl (initial JSONL of this process lifetime)
    const exactMatch = candidates.find(c => c.convId === input.hookSid);

    // 2. Try persisted hint
    const persistedMatch = input.persistedConversationId
      ? candidates.find(c => c.convId === input.persistedConversationId)
      : undefined;

    // 3. Rank remaining by mtime
    const ranked = this.rankByMtime(candidates, input.hookTimestampMs, input.hookEvent);

    // Pick best candidate with confidence assessment
    let chosen: CandidateFile | undefined;
    let confidence: ResolverConfidence = 'none';
    let reason: ResolverReason = 'no_candidates';

    // Priority: exact match (if high-confidence) > persisted hint > mtime ranking
    if (exactMatch) {
      const conf = this.mtimeConfidence(exactMatch.mtimeMs, input.hookTimestampMs, input.hookEvent);
      if (conf !== 'none') {
        chosen = exactMatch;
        confidence = conf;
        reason = 'initial_assignment';
      }
    }

    let persistedRejected: string | undefined;
    if (!chosen && persistedMatch) {
      const conf = this.mtimeConfidence(persistedMatch.mtimeMs, input.hookTimestampMs, input.hookEvent);
      if (conf !== 'none') {
        // Claim B fix: persisted hint may win ONLY if it equals topRanked (same file)
        // or its mtime is strictly newer than topRanked. No tolerance window — a
        // persisted hint with equal-or-older mtime is stale and must yield to disk
        // evidence. This prevents sibling panes in shared-cwd from stealing each
        // other's persisted convId.
        const topRanked = ranked[0];
        const persistedIsCompetitive = !topRanked
          || topRanked.convId === persistedMatch.convId
          || persistedMatch.mtimeMs > topRanked.mtimeMs;
        if (persistedIsCompetitive) {
          chosen = persistedMatch;
          confidence = conf;
          reason = 'mtime_newest_unclaimed';
        } else {
          persistedRejected = 'persisted_overruled_by_mtime';
          logger.debug('resolver: persisted hint overruled by mtime', {
            identity, persisted: persistedMatch.convId, persistedMtime: persistedMatch.mtimeMs,
            topRanked: topRanked.convId, topMtime: topRanked.mtimeMs,
          });
        }
      }
    }

    if (!chosen && ranked.length > 0) {
      const top = ranked[0]!;
      const conf = this.mtimeConfidence(top.mtimeMs, input.hookTimestampMs, input.hookEvent);

      if (conf === 'none') {
        // All candidates too old — try last-line probe as tiebreaker
        if (!this.opts.skipContentProbes) {
          const probed = this.probeLastLine(ranked, input.hookTimestampMs);
          if (probed) {
            chosen = probed;
            confidence = 'medium';
            reason = 'last_line_timestamp_match';
          }
        }
        // If still no winner → fail-closed
      } else {
        // Sticky check (BEFORE ambiguity): if current exists and top is only marginally
        // newer than current, keep current rather than rotating.
        if (current && top.convId !== current) {
          const currentFile = candidates.find(c => c.convId === current);
          if (currentFile) {
            const delta = top.mtimeMs - currentFile.mtimeMs;
            if (delta < STICKY_MIN_DELTA_MS) {
              logger.debug('resolver: sticky_kept', {
                identity, current, candidate: top.convId, deltaMs: delta,
              });
              return this.makeResult(current, 'none', 'sticky_kept', currentFile, current);
            }
          }
        }

        // Ambiguity check: when top vs second are within threshold (and sticky didn't fire)
        if (ranked.length >= 2) {
          const second = ranked[1]!;
          const topIsAmbiguous =
            top.convId !== current &&
            Math.abs(top.mtimeMs - second.mtimeMs) < STICKY_MIN_DELTA_MS;

          if (topIsAmbiguous && !this.opts.skipContentProbes) {
            // Same-second tie: use last-line probe to disambiguate
            const probed = this.probeLastLine([top, second], input.hookTimestampMs);
            if (probed) {
              chosen = probed;
              confidence = conf;
              reason = 'last_line_timestamp_match';
            } else {
              // Truly ambiguous — fail-closed
              return this.makeResult(current ?? null, 'none', 'candidate_claimed_by_sibling', top, current);
            }
          } else {
            chosen = top;
            confidence = conf;
            reason = 'mtime_newest_unclaimed';
          }
        } else {
          chosen = top;
          confidence = conf;
          reason = 'mtime_newest_unclaimed';
        }
      }
    }

    if (!chosen || confidence === 'none') {
      const res = this.makeResult(current ?? null, 'none',
        reason === 'no_candidates' ? 'no_candidates' : 'confidence_too_low', null, current);
      if (input.persistedConversationId) res.persistedConvIdSeen = input.persistedConversationId;
      if (persistedRejected) res.claimRejectedReason = persistedRejected;
      return res;
    }

    // Commit the claim
    if (current && current !== chosen.convId) {
      // Release old claim
      this.claimTable.delete(current);
    }
    this.claimTable.set(chosen.convId, identity);
    this.identityTable.set(identity, chosen.convId);

    const rotated = current !== chosen.convId;
    logger.debug('resolver: claim', {
      identity, convId: chosen.convId, confidence, reason, rotated,
    });

    return {
      conversationId: chosen.convId,
      confidence,
      reason,
      evidence: {
        jsonlPath: chosen.path,
        mtimeMs: chosen.mtimeMs,
        size: chosen.size,
        lastLineTimestampMs: null,
      },
      rotated,
      ...(input.persistedConversationId ? { persistedConvIdSeen: input.persistedConversationId } : {}),
      ...(persistedRejected ? { claimRejectedReason: persistedRejected } : {}),
    };
  }

  /**
   * Release the claim held by identity.
   * Silent no-op if identity holds no claim.
   */
  release(identity: string): void {
    const convId = this.identityTable.get(identity);
    if (convId) {
      this.claimTable.delete(convId);
      this.identityTable.delete(identity);
      logger.debug('resolver: release', { identity, convId });
    }
  }

  /**
   * Read-only: get the convId currently claimed by identity.
   */
  getClaimed(identity: string): string | null {
    return this.identityTable.get(identity) ?? null;
  }

  /**
   * Diagnostic snapshot of the full claim table.
   */
  snapshotClaimTable(): Map<string, string> {
    return new Map(this.claimTable);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * List JSONL candidates for the given cwd, filtered to unclaimed-by-others files.
   * Sorted by mtime descending.
   */
  private scanCandidates(cwd: string, forIdentity: string): CandidateFile[] {
    const slug = cwdToSlug(cwd);
    const primaryDir = path.join(this.claudeDir, 'projects', slug);

    let files = this.listDir(primaryDir);

    // Worktree fallback: scan slug-* sibling directories
    if (files.length === 0) {
      try {
        const projectsDir = path.join(this.claudeDir, 'projects');
        const siblings = fs.readdirSync(projectsDir)
          .filter(d => d !== slug && d.startsWith(slug + '-'));
        for (const sibling of siblings) {
          const siblingFiles = this.listDir(path.join(projectsDir, sibling));
          if (siblingFiles.length > 0) {
            files = siblingFiles;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Filter: exclude JSONLs claimed by OTHER identities
    return files.filter(f => {
      const claimedBy = this.claimTable.get(f.convId);
      return !claimedBy || claimedBy === forIdentity;
    });
  }

  /**
   * List JSONL files in a directory, sorted by mtime descending.
   * Uses a 200ms in-memory cache keyed by directory mtime.
   */
  private listDir(dir: string): CandidateFile[] {
    const now = Date.now();
    const cached = this.dirCache.get(dir);
    if (cached && cached.expiresAt > now) return cached.files;

    try {
      const files: CandidateFile[] = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const p = path.join(dir, f);
          try {
            const st = fs.statSync(p);
            return { convId: f.slice(0, -6), path: p, mtimeMs: st.mtimeMs, size: st.size };
          } catch {
            return null;
          }
        })
        .filter((f): f is CandidateFile => f !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      this.dirCache.set(dir, { files, expiresAt: now + DIR_CACHE_TTL_MS });
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Rank candidates by proximity to hook timestamp, preferring freshly written files.
   */
  private rankByMtime(candidates: CandidateFile[], hookTs: number, _event: HookEvent): CandidateFile[] {
    return [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Assess confidence based on how recently the file was modified relative to the hook.
   */
  private mtimeConfidence(mtimeMs: number, hookTs: number, event: HookEvent): ResolverConfidence {
    const age = hookTs - mtimeMs;

    // For rehydrate (cold start): accept older files — they may not have been touched recently
    if (event === 'rehydrate') {
      if (age < MEDIUM_CONFIDENCE_WINDOW_MS * 60) return 'medium'; // up to 1 hour
      return 'low';
    }

    if (age <= HOOK_WRITE_WINDOW_MS) return 'high';
    if (age <= MEDIUM_CONFIDENCE_WINDOW_MS) return 'medium';
    // Don't return 'low' as a rotation trigger — low confidence never causes rotation
    return 'none';
  }

  /**
   * Probe the last LAST_LINE_PROBE_BYTES of each candidate to find one whose
   * trailing JSON event has a timestamp within HOOK_TIMESTAMP_TOLERANCE_MS of hookTs.
   */
  private probeLastLine(candidates: CandidateFile[], hookTs: number): CandidateFile | undefined {
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate.path);
        if (stat.size === 0) continue;

        const readSize = Math.min(stat.size, LAST_LINE_PROBE_BYTES);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(candidate.path, 'r');
        try {
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        } finally {
          fs.closeSync(fd);
        }

        const text = buf.toString('utf8');
        // Find the last complete JSON line
        const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
        if (lines.length === 0) continue;

        const lastLine = lines[lines.length - 1]!;
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        const ts = typeof parsed['ts'] === 'number' ? parsed['ts'] as number : undefined;

        if (ts !== undefined && Math.abs(ts - hookTs) <= HOOK_TIMESTAMP_TOLERANCE_MS) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private makeResult(
    convId: string | null,
    confidence: ResolverConfidence,
    reason: ResolverReason,
    file: CandidateFile | null,
    previous: string | undefined,
  ): ResolverResult {
    return {
      conversationId: convId,
      confidence,
      reason,
      evidence: {
        jsonlPath: file?.path ?? null,
        mtimeMs: file?.mtimeMs ?? null,
        size: file?.size ?? null,
        lastLineTimestampMs: null,
      },
      rotated: convId !== null && convId !== previous,
    };
  }

  /** Invalidate dir cache (useful after externally knowing a new file was created) */
  invalidateCache(cwd: string): void {
    const slug = cwdToSlug(cwd);
    const dir = path.join(this.claudeDir, 'projects', slug);
    this.dirCache.delete(dir);
  }
}
