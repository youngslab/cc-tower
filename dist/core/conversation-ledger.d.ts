/**
 * ConversationLedger — append-only O_APPEND ledger for conversation rotation events.
 *
 * Written to ~/.config/popmux/conversation-ledger.jsonl.
 * Rotates to .1 when the file exceeds 10 MB (existing .1 is overwritten).
 * Each entry is ≤4 KB. Skipped in skipColdStart / readOnly mode.
 */
export interface LedgerEntry {
    ts: string;
    identity: string;
    from: string | null;
    to: string;
    trigger: string;
    confidence: string;
    reason: string;
    claimTableSize: number;
    evidence: {
        mtimeMs: number | null;
        size: number | null;
        lastLineTimestampMs: number | null;
    };
    persistedConvIdSeen?: string;
    chosenVsPersistedSame?: boolean;
    claimRejectedReason?: string;
    metaDropped?: {
        identity: string;
        oldSessionId: string;
        newSessionId: string;
        droppedKeys?: string[];
    };
}
export declare class ConversationLedger {
    private readonly ledgerPath;
    constructor(configDir?: string);
    append(entry: LedgerEntry): void;
}
