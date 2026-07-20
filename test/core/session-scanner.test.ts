import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionScanner } from '../../src/core/session-scanner.js';

let projectsDir: string;

/** Write a JSONL file under projectsDir/<slug>/<sessionId>.jsonl from raw lines. */
function writeSession(slug: string, sessionId: string, lines: string[]): void {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

const meta = (type: string) => JSON.stringify({ type });
const cwdLine = (cwd: string, ts?: string) =>
  JSON.stringify({ type: 'user', cwd, ...(ts ? { timestamp: ts } : {}) });

beforeEach(() => { projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-')); });
afterEach(() => { fs.rmSync(projectsDir, { recursive: true, force: true }); });

describe('SessionScanner', () => {
  it('extracts cwd + startedAt + sessionId with cwd on a later line', async () => {
    writeSession('-home-me-proj', 'sess-1', [
      meta('summary'), meta('custom-title'),
      cwdLine('/home/me/proj', '2026-06-20T10:00:00.000Z'),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    const got = s.getCached();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ sessionId: 'sess-1', cwd: '/home/me/proj' });
    expect(got[0]!.startedAt).toBe(Date.parse('2026-06-20T10:00:00.000Z'));
  });

  it('finds early cwd even when a later line exceeds the 16KB head (truncated tail discarded)', async () => {
    const huge = JSON.stringify({ type: 'attachment', data: 'x'.repeat(30000) });
    writeSession('-p', 'sess-big', [
      meta('summary'),
      cwdLine('/home/me/early', '2026-06-20T10:00:00.000Z'), // within first 16KB
      huge, // >16KB → truncated by head read, discarded as partial
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]).toMatchObject({ sessionId: 'sess-big', cwd: '/home/me/early' });
  });

  it('reads cwd from content, NOT from the lossy slug', async () => {
    // slug collapses '.' → '-'; real cwd has '.0' which the slug cannot represent.
    writeSession('-home-me-ccu-2-0-x', 'sess-lossy', [
      meta('summary'),
      cwdLine('/home/me/ccu-2.0/x', '2026-06-20T10:00:00.000Z'),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.cwd).toBe('/home/me/ccu-2.0/x'); // the '.0', not slug 'ccu-2-0'
  });

  it('handles multibyte (Korean/Cyrillic) cwd paths', async () => {
    const cwd = '/home/kevin.park/작업/проект';
    writeSession('-multibyte', 'sess-mb', [meta('summary'), cwdLine(cwd, '2026-06-20T10:00:00.000Z')]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.cwd).toBe(cwd);
  });

  it('falls back to file mtime when the cwd line has no timestamp', async () => {
    writeSession('-p', 'sess-nots', [meta('summary'), cwdLine('/home/me/x')]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.startedAt).toBeGreaterThan(0);
  });

  it('extracts customTitle from a /rename custom-title record', async () => {
    writeSession('-p', 'sess-ct', [
      meta('summary'),
      JSON.stringify({ type: 'custom-title', customTitle: 'my-renamed', sessionId: 'sess-ct' }),
      cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z'),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]).toMatchObject({ sessionId: 'sess-ct', cwd: '/home/me/p', customTitle: 'my-renamed' });
  });

  it('leaves customTitle undefined when there is no custom-title record', async () => {
    writeSession('-p', 'sess-noct', [meta('summary'), cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z')]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.customTitle).toBeUndefined();
  });

  it('finds a /rename that lands well past the 16KB head via the tail-scan fallback', async () => {
    // cwd within head; then >1MB of filler pushing the /rename far past the head read.
    const filler = Array.from({ length: 40 }, () => JSON.stringify({ type: 'filler', data: 'x'.repeat(30000) }));
    writeSession('-p', 'sess-late-rename', [
      cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z'),
      ...filler,
      JSON.stringify({ type: 'custom-title', customTitle: 'late-renamed', sessionId: 'sess-late-rename' }),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]).toMatchObject({ sessionId: 'sess-late-rename', customTitle: 'late-renamed' });
  });

  it('uses the LAST /rename when renamed multiple times within the head', async () => {
    writeSession('-p', 'sess-multi-head', [
      cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z'),
      JSON.stringify({ type: 'custom-title', customTitle: 'first-name' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'second-name' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'final-name' }),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.customTitle).toBe('final-name');
  });

  it('prefers a rename found in the tail over an earlier one found in the head', async () => {
    const filler = Array.from({ length: 40 }, () => JSON.stringify({ type: 'filler', data: 'x'.repeat(30000) }));
    writeSession('-p', 'sess-multi-split', [
      cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z'),
      JSON.stringify({ type: 'custom-title', customTitle: 'early-name' }), // within head
      ...filler,
      JSON.stringify({ type: 'custom-title', customTitle: 'late-name' }), // past head, in tail
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.customTitle).toBe('late-name');
  });

  it('gives up (customTitle undefined) when the rename is beyond the 1MB tail-scan cap', async () => {
    const fillerBefore = Array.from({ length: 2 }, () => JSON.stringify({ type: 'filler', data: 'x'.repeat(30000) }));
    const fillerAfter = Array.from({ length: 40 }, () => JSON.stringify({ type: 'filler', data: 'x'.repeat(30000) }));
    writeSession('-p', 'sess-too-far', [
      cwdLine('/home/me/p', '2026-06-20T10:00:00.000Z'),
      ...fillerBefore, // pushes the rename past the 16KB head read
      JSON.stringify({ type: 'custom-title', customTitle: 'unreachable', sessionId: 'sess-too-far' }),
      ...fillerAfter, // pushes the rename beyond the 1MB tail-scan cap from EOF
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]!.customTitle).toBeUndefined();
  });

  it('skips files with no cwd in the head', async () => {
    writeSession('-p', 'sess-nocwd', [meta('summary'), meta('agent-name'), meta('last-prompt')]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()).toHaveLength(0);
  });

  it('skips empty and corrupt files without throwing', async () => {
    writeSession('-p', 'sess-good', [meta('summary'), cwdLine('/home/me/g', '2026-06-20T10:00:00.000Z')]);
    fs.writeFileSync(path.join(projectsDir, '-p', 'sess-empty.jsonl'), '');
    fs.writeFileSync(path.join(projectsDir, '-p', 'sess-corrupt.jsonl'), 'not json\n{also bad\n');
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    const ids = s.getCached().map(x => x.sessionId);
    expect(ids).toContain('sess-good');
    expect(ids).not.toContain('sess-empty');
    expect(ids).not.toContain('sess-corrupt');
  });

  it('reads only a bounded head of a >1MB file', async () => {
    const big = 'y'.repeat(1_200_000);
    writeSession('-p', 'sess-1mb', [
      meta('summary'),
      cwdLine('/home/me/big', '2026-06-20T10:00:00.000Z'),
      JSON.stringify({ type: 'noise', data: big }),
    ]);
    const s = new SessionScanner(projectsDir);
    await s.ensureScanned();
    expect(s.getCached()[0]).toMatchObject({ sessionId: 'sess-1mb', cwd: '/home/me/big' });
  });

  it('returns empty (no throw) when the projects dir is missing', async () => {
    const s = new SessionScanner(path.join(projectsDir, 'does-not-exist'));
    await s.ensureScanned();
    expect(s.isScanned()).toBe(true);
    expect(s.getCached()).toHaveLength(0);
  });

  it('isScanned() flips true and ensureScanned() is idempotent', async () => {
    writeSession('-p', 'sess-x', [meta('summary'), cwdLine('/home/me/x', '2026-06-20T10:00:00.000Z')]);
    const s = new SessionScanner(projectsDir);
    expect(s.isScanned()).toBe(false);
    await Promise.all([s.ensureScanned(), s.ensureScanned()]); // shared in-flight
    expect(s.isScanned()).toBe(true);
    expect(s.getCached()).toHaveLength(1);
  });

  it('CVL: scans 200 files well under a generous bound', async () => {
    for (let i = 0; i < 200; i++) {
      writeSession(`-proj-${i % 10}`, `sess-${i}`, [
        meta('summary'),
        cwdLine(`/home/me/proj${i % 10}`, '2026-06-20T10:00:00.000Z'),
      ]);
    }
    const s = new SessionScanner(projectsDir);
    const start = Date.now();
    await s.ensureScanned();
    const elapsed = Date.now() - start;
    expect(s.getCached()).toHaveLength(200);
    expect(elapsed).toBeLessThan(5000); // generous; real cost is ~tens of ms
  });
});
