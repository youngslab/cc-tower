/**
 * ConversationLedger — append-only O_APPEND ledger for conversation rotation events.
 *
 * Written to ~/.config/popmux/conversation-ledger.jsonl.
 * Rotates to .1 when the file exceeds 10 MB (existing .1 is overwritten).
 * Each entry is ≤4 KB. Skipped in skipColdStart / readOnly mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';

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
  // Step 6 / Amendment 3 observability fields:
  persistedConvIdSeen?: string;
  chosenVsPersistedSame?: boolean;
  claimRejectedReason?: string;
  metaDropped?: { identity: string; oldSessionId: string; newSessionId: string; droppedKeys?: string[] };
}

const LEDGER_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class ConversationLedger {
  private readonly ledgerPath: string;

  constructor(configDir?: string) {
    const dir = configDir ?? path.join(os.homedir(), '.config', 'popmux');
    this.ledgerPath = path.join(dir, 'conversation-ledger.jsonl');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  append(entry: LedgerEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      // Rotate if over limit
      try {
        const stat = fs.statSync(this.ledgerPath);
        if (stat.size >= LEDGER_MAX_BYTES) {
          fs.renameSync(this.ledgerPath, this.ledgerPath + '.1');
        }
      } catch {}
      fs.writeFileSync(this.ledgerPath, line, { flag: 'a', encoding: 'utf8' });
    } catch (err) {
      logger.debug('conversation-ledger: write error', { error: String(err) });
    }
  }
}
