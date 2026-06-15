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
export type HookEvent = 'session-start' | 'user-prompt' | 'pre-tool' | 'post-tool' | 'stop' | 'rehydrate' | 'unknown';
export type ResolverConfidence = 'high' | 'medium' | 'low' | 'none';
export type ResolverReason = 'initial_assignment' | 'mtime_newest_unclaimed' | 'last_line_timestamp_match' | 'sticky_kept' | 'candidate_claimed_by_sibling' | 'confidence_too_low' | 'no_candidates' | 'persisted_overruled_by_mtime';
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
export declare class ConversationResolver {
    private readonly claudeDir;
    private readonly opts;
    /** convId → identity that claimed it */
    private readonly claimTable;
    /** identity → convId it currently holds */
    private readonly identityTable;
    /** Per-slug directory listing cache */
    private readonly dirCache;
    constructor(claudeDir: string, opts?: ConversationResolverOptions);
    /**
     * Atomically resolve and claim a JSONL for the given instance.
     * If a better candidate is found and passes the sticky rule, the claim table
     * is updated and rotated=true is returned.
     */
    claim(input: ResolverInput): ResolverResult;
    /**
     * Release the claim held by identity.
     * Silent no-op if identity holds no claim.
     */
    release(identity: string): void;
    /**
     * Read-only: get the convId currently claimed by identity.
     */
    getClaimed(identity: string): string | null;
    /**
     * Diagnostic snapshot of the full claim table.
     */
    snapshotClaimTable(): Map<string, string>;
    /**
     * List JSONL candidates for the given cwd, filtered to unclaimed-by-others files.
     * Sorted by mtime descending.
     */
    private scanCandidates;
    /**
     * List JSONL files in a directory, sorted by mtime descending.
     * Uses a 200ms in-memory cache keyed by directory mtime.
     */
    private listDir;
    /**
     * Rank candidates by proximity to hook timestamp, preferring freshly written files.
     */
    private rankByMtime;
    /**
     * Assess confidence based on how recently the file was modified relative to the hook.
     */
    private mtimeConfidence;
    /**
     * Probe the last LAST_LINE_PROBE_BYTES of each candidate to find one whose
     * trailing JSON event has a timestamp within HOOK_TIMESTAMP_TOLERANCE_MS of hookTs.
     */
    private probeLastLine;
    private makeResult;
    /** Invalidate dir cache (useful after externally knowing a new file was created) */
    invalidateCache(cwd: string): void;
}
