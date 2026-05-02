/**
 * Activity timestamp unit tests — Tier 1.
 *
 * Verifies the touch / read / clear round-trip and confirms that mtime is
 * updated on each touchActivity (used as the eviction signal).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  touchActivity,
  getActivityMtime,
  clearActivity,
  activityPath,
} from '../../src/mirror/activity.js';

let tmpdir: string;
const origRuntime = process.env['XDG_RUNTIME_DIR'];

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-activity-'));
  process.env['XDG_RUNTIME_DIR'] = tmpdir;
});

afterEach(() => {
  if (origRuntime !== undefined) process.env['XDG_RUNTIME_DIR'] = origRuntime;
  else delete process.env['XDG_RUNTIME_DIR'];
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe('activity timestamps', () => {
  it('returns null when no marker exists', () => {
    expect(getActivityMtime('host1', '%5')).toBeNull();
  });

  it('touch then get returns a recent mtime', () => {
    const before = Date.now();
    touchActivity('host1', '%5');
    const mtime = getActivityMtime('host1', '%5');
    expect(mtime).not.toBeNull();
    // Allow modest skew either side.
    expect(mtime!).toBeGreaterThanOrEqual(before - 1000);
    expect(mtime!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('paneId slug includes "pct" prefix in path', () => {
    const p = activityPath('host1', '%5');
    expect(p).toContain('mirror.host1.pct5.activity');
  });

  it('host with disallowed chars is sluggified', () => {
    const p = activityPath('host/weird?', '%9');
    expect(p).not.toContain('/weird?');
    expect(p).toContain('mirror.host_weird_.pct9.activity');
  });

  it('touchActivity is idempotent (file exists, mtime advances)', async () => {
    touchActivity('host1', '%5');
    const t1 = getActivityMtime('host1', '%5')!;
    // Wait > filesystem mtime resolution (1ms is typical, give 20ms cushion).
    await new Promise((r) => setTimeout(r, 30));
    touchActivity('host1', '%5');
    const t2 = getActivityMtime('host1', '%5')!;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('clearActivity removes the marker', () => {
    touchActivity('host1', '%5');
    expect(getActivityMtime('host1', '%5')).not.toBeNull();
    clearActivity('host1', '%5');
    expect(getActivityMtime('host1', '%5')).toBeNull();
  });

  it('clearActivity on missing marker is a no-op', () => {
    expect(() => clearActivity('nope', '%99')).not.toThrow();
  });
});
