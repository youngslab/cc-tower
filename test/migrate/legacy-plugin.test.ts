import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disableLegacyCcTowerPlugin } from '../../src/migrate/legacy-plugin.js';

/**
 * Plan v2 §3.4 / C4: install-hooks must rename ~/.claude/plugins/cc-tower/plugin.json
 * to plugin.json.disabled so legacy v1 hooks stop firing once popmux takes over.
 * Idempotent — re-running on an already-disabled state is a no-op.
 */
describe('disableLegacyCcTowerPlugin (Plan v2 §3.4 / C4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'popmux-legacy-plugin-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function setupLegacyPlugin(opts: { live?: boolean; disabled?: boolean } = {}): { pluginDir: string } {
    const pluginDir = path.join(tmpHome, '.claude', 'plugins', 'cc-tower');
    fs.mkdirSync(pluginDir, { recursive: true });
    if (opts.live ?? true) {
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), '{"name":"cc-tower"}');
    }
    if (opts.disabled) {
      fs.writeFileSync(path.join(pluginDir, 'plugin.json.disabled'), '{"old":true}');
    }
    return { pluginDir };
  }

  it('renames plugin.json → plugin.json.disabled when only live present', () => {
    const { pluginDir } = setupLegacyPlugin({ live: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = disableLegacyCcTowerPlugin(tmpHome);

    expect(result.disabled).toBe(true);
    expect(result.alreadyDisabled).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'plugin.json'))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'plugin.json.disabled'))).toBe(true);
    // Sanity: stderr message mentions the path so users see what happened.
    expect(stderrSpy).toHaveBeenCalled();
    const msg = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('Disabled legacy cc-tower plugin');
    expect(msg).toContain(pluginDir);

    stderrSpy.mockRestore();
  });

  it('is a no-op when plugin.json is absent (already disabled state)', () => {
    setupLegacyPlugin({ live: false, disabled: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = disableLegacyCcTowerPlugin(tmpHome);

    expect(result.disabled).toBe(false);
    expect(result.alreadyDisabled).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('is a no-op when nothing exists (fresh popmux install)', () => {
    // No plugin dir at all — simulates fresh install.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = disableLegacyCcTowerPlugin(tmpHome);

    expect(result.disabled).toBe(false);
    expect(result.alreadyDisabled).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('overwrites stale .disabled marker when both files exist', () => {
    const { pluginDir } = setupLegacyPlugin({ live: true, disabled: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), '{"name":"cc-tower","fresh":true}');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = disableLegacyCcTowerPlugin(tmpHome);
    stderrSpy.mockRestore();

    expect(result.disabled).toBe(true);
    expect(result.alreadyDisabled).toBe(true);
    // The fresh plugin.json content should now live in .disabled.
    const disabledContent = fs.readFileSync(path.join(pluginDir, 'plugin.json.disabled'), 'utf8');
    expect(disabledContent).toContain('"fresh":true');
    expect(fs.existsSync(path.join(pluginDir, 'plugin.json'))).toBe(false);
  });

  it('two consecutive calls are idempotent (second is a no-op)', () => {
    setupLegacyPlugin({ live: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const first = disableLegacyCcTowerPlugin(tmpHome);
    const second = disableLegacyCcTowerPlugin(tmpHome);

    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(false);
    expect(second.alreadyDisabled).toBe(true);
    // Only the first call writes to stderr.
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    stderrSpy.mockRestore();
  });
});
