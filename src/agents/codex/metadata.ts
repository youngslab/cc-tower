import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import type { CodexThreadRow } from './types.js';

interface RawThreadRow {
  id?: unknown;
  cwd?: unknown;
  title?: unknown;
  name?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
}

export function findCodexStateDb(codexHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')): string | undefined {
  try {
    if (!existsSync(codexHome)) return undefined;
    const candidates = readdirSync(codexHome)
      .filter((name) => /^state_.*\.sqlite$/.test(name))
      .map((name) => join(codexHome, name))
      .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.file;
  } catch {
    return undefined;
  }
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeRows(rows: RawThreadRow[]): CodexThreadRow[] {
  return rows
    .map((row): CodexThreadRow | null => {
      if (typeof row.id !== 'string' || !row.id) return null;
      return {
        id: row.id,
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        title: typeof row.title === 'string' && row.title ? row.title : undefined,
        name: typeof row.name === 'string' && row.name ? row.name : undefined,
        updatedAt: toMs(row.updated_at),
        createdAt: toMs(row.created_at),
      };
    })
    .filter((row): row is CodexThreadRow => row !== null);
}

/**
 * Read Codex thread metadata through Python's stdlib sqlite3 in read-only URI mode.
 * This module intentionally never writes to Codex SQLite; failures return [] so the
 * popup can fall back to process-derived labels without blocking.
 */
export function readCodexThreads(opts: { codexHome?: string; dbPath?: string; limit?: number } = {}): CodexThreadRow[] {
  const dbPath = opts.dbPath ?? findCodexStateDb(opts.codexHome);
  if (!dbPath) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const script = String.raw`
import json, sqlite3, sys
path = sys.argv[1]
limit = int(sys.argv[2])
conn = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=0.2)
conn.row_factory = sqlite3.Row
rows = conn.execute('select id, cwd, title, name, updated_at, created_at from threads order by coalesce(updated_at, created_at) desc limit ?', (limit,)).fetchall()
print(json.dumps([dict(row) for row in rows]))
conn.close()
`;
  try {
    const stdout = execFileSync('python3', ['-c', script, dbPath, String(limit)], {
      encoding: 'utf8',
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeRows(JSON.parse(stdout) as RawThreadRow[]);
  } catch (err) {
    logger.debug('codex.metadata: read failed', { dbPath, error: String(err) });
    return [];
  }
}

function latestFirst(rows: CodexThreadRow[]): CodexThreadRow[] {
  return [...rows].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
}

function labelFromThread(
  row: CodexThreadRow,
  opts: { titleAsRename?: boolean } = {},
): { label?: string; labelSource?: 'codex-title' | 'codex-rename' } {
  if (row.name) return { label: row.name, labelSource: 'codex-rename' };
  if (row.title) return { label: row.title, labelSource: opts.titleAsRename ? 'codex-rename' : 'codex-title' };
  return {};
}

function closeToStartedAt(rows: CodexThreadRow[], sessionStartedAt: number): CodexThreadRow[] {
  const toleranceSeconds = 30;
  return rows.filter((row) => {
    if (row.createdAt === undefined) return false;
    return Math.abs(row.createdAt - sessionStartedAt) <= toleranceSeconds;
  });
}

export function resolveCodexThreadMetadata(input: {
  cwd: string;
  resumeArg?: string | undefined;
  resumeWithoutArg?: boolean | undefined;
  sessionStartedAt?: number | undefined;
  threads: CodexThreadRow[];
  claimedThreadIds?: Set<string>;
}): {
  threadId?: string;
  label?: string;
  labelSource?: 'codex-title' | 'codex-rename';
  confidence: 'low' | 'medium' | 'high';
  resumable: boolean;
} {
  const claimed = input.claimedThreadIds ?? new Set<string>();
  const unclaimed = input.threads.filter((row) => !claimed.has(row.id));

  if (input.resumeArg) {
    const exact = unclaimed.find((row) => row.id === input.resumeArg);
    if (exact) {
      return {
        threadId: exact.id,
        ...labelFromThread(exact),
        confidence: 'high',
        resumable: true,
      };
    }

    const claimedExact = input.threads.find((row) => row.id === input.resumeArg);
    if (claimedExact) {
      return {
        ...labelFromThread(claimedExact),
        confidence: 'medium',
        resumable: false,
      };
    }

    const titleMatches = input.threads.filter((row) => row.title === input.resumeArg);
    const unclaimedTitleMatches = titleMatches.filter((row) => !claimed.has(row.id));
    if (titleMatches.length === 1 && unclaimedTitleMatches.length === 1) {
      const match = unclaimedTitleMatches[0]!;
      return {
        threadId: match.id,
        ...labelFromThread(match),
        confidence: 'high',
        resumable: true,
      };
    }

    if (titleMatches.length > 1) {
      const match = latestFirst(titleMatches)[0]!;
      return {
        ...labelFromThread(match),
        confidence: 'medium',
        resumable: false,
      };
    }

    if (titleMatches.length > 0) {
      const match = titleMatches[0]!;
      return {
        ...labelFromThread(match),
        confidence: 'medium',
        resumable: false,
      };
    }
  }

  const cwdMatches = latestFirst(unclaimed.filter((row) => row.cwd === input.cwd));
  if (input.sessionStartedAt !== undefined) {
    const startedAtMatches = latestFirst(closeToStartedAt(cwdMatches, input.sessionStartedAt));
    if (startedAtMatches.length === 1) {
      const match = startedAtMatches[0]!;
      return {
        threadId: match.id,
        ...labelFromThread(match),
        confidence: 'high',
        resumable: true,
      };
    }
  }

  if (input.resumeWithoutArg && cwdMatches.length > 0) {
    const match = cwdMatches[0]!;
    return {
      threadId: match.id,
      ...labelFromThread(match, { titleAsRename: true }),
      confidence: 'high',
      resumable: true,
    };
  }

  if (cwdMatches.length === 1) {
    const match = cwdMatches[0]!;
    return {
      threadId: match.id,
      ...labelFromThread(match),
      confidence: 'high',
      resumable: true,
    };
  }

  if (cwdMatches.length > 1) {
    const match = cwdMatches[0]!;
    return {
      ...labelFromThread(match),
      confidence: 'medium',
      resumable: false,
    };
  }

  return { confidence: 'low', resumable: false };
}
