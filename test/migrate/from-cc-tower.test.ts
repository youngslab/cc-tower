import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Helper: override os.homedir() by patching HOME env var before importing the module.
// We re-import the module inside each test via dynamic import with cache busting
// so HOME changes take effect. Simpler approach: pass tmpHome and construct paths
// manually, then verify the module uses os.homedir() — but since the module reads
// homedir() at call time (not module load time), we just set process.env.HOME.

async function importMigrate() {
  // Force fresh module resolution by appending a dummy query (works with tsx/vitest)
  const { detectLegacy, migrateFromCcTower } = await import('../../src/migrate/from-cc-tower.js');
  return { detectLegacy, migrateFromCcTower };
}

describe('from-cc-tower migration', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cc-migrate-test-'));
    origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env['HOME'] = origHome;
    } else {
      delete process.env['HOME'];
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  // Helper paths relative to tmpHome
  const srcDir = () => join(tmpHome, '.config', 'cc-tower');
  const dstDir = () => join(tmpHome, '.config', 'popmux');
  const marker = () => join(dstDir(), '.migrated-from-cc-tower');
  const pluginDir = () => join(tmpHome, '.claude', 'plugins', 'cc-tower');

  async function createSrcState(sessions: Record<string, unknown> = {}) {
    await mkdir(srcDir(), { recursive: true });
    const content = { sessions };
    await writeFile(join(srcDir(), 'state.json'), JSON.stringify(content, null, 2));
  }

  async function createSrcConfig() {
    await mkdir(srcDir(), { recursive: true });
    await writeFile(join(srcDir(), 'config.yaml'), '# cc-tower config\nhosts: []\n');
  }

  // --- detectLegacy ---

  describe('detectLegacy()', () => {
    it('returns all false when nothing exists', async () => {
      const { detectLegacy } = await importMigrate();
      const result = detectLegacy();
      expect(result).toEqual({ hasSrcDir: false, hasMarker: false, hasPlugin: false });
    });

    it('detects srcDir', async () => {
      await mkdir(srcDir(), { recursive: true });
      const { detectLegacy } = await importMigrate();
      const result = detectLegacy();
      expect(result.hasSrcDir).toBe(true);
      expect(result.hasMarker).toBe(false);
      expect(result.hasPlugin).toBe(false);
    });

    it('detects marker', async () => {
      await mkdir(dstDir(), { recursive: true });
      await writeFile(marker(), '{}');
      const { detectLegacy } = await importMigrate();
      const result = detectLegacy();
      expect(result.hasMarker).toBe(true);
    });

    it('detects legacy plugin', async () => {
      await mkdir(pluginDir(), { recursive: true });
      const { detectLegacy } = await importMigrate();
      const result = detectLegacy();
      expect(result.hasPlugin).toBe(true);
    });
  });

  // --- migrateFromCcTower ---

  describe('migrateFromCcTower()', () => {
    it('copies state.json to popmux dir', async () => {
      const sessions = {
        'abc-123': { pid: 1, projectName: 'my-project', status: 'idle' },
      };
      await createSrcState(sessions);

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      expect(result.migrated.state).toBe(true);
      expect(existsSync(join(dstDir(), 'state.json'))).toBe(true);

      const copied = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      // Content should be present
      expect(copied.sessions['abc-123'].projectName).toBe('my-project');

      // Marker created
      expect(existsSync(marker())).toBe(true);
      expect(result.skipped.reason).toBeUndefined();
    });

    it('fills agentId: "claude" on each session entry that lacks it', async () => {
      const sessions = {
        'sess-1': { pid: 1, status: 'idle' },
        'sess-2': { pid: 2, status: 'busy', agentId: 'existing' },
      };
      await createSrcState(sessions);

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      // Only sess-1 should be filled (sess-2 already had agentId)
      expect(result.migrated.agentIdFilled).toBe(1);

      const copied = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      expect(copied.sessions['sess-1'].agentId).toBe('claude');
      expect(copied.sessions['sess-2'].agentId).toBe('existing');
    });

    it('fills agentId on ALL entries when none have it', async () => {
      const sessions = {
        'a': { pid: 1, status: 'idle' },
        'b': { pid: 2, status: 'idle' },
        'c': { pid: 3, status: 'idle' },
      };
      await createSrcState(sessions);

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      expect(result.migrated.agentIdFilled).toBe(3);
    });

    it('second call with marker present → skipped (no-op)', async () => {
      await createSrcState({ 'x': { pid: 1 } });

      const { migrateFromCcTower } = await importMigrate();
      migrateFromCcTower(); // first call

      const result2 = migrateFromCcTower(); // second call
      expect(result2.migrated.state).toBe(false);
      expect(result2.migrated.config).toBe(false);
      expect(result2.skipped.reason).toMatch(/already migrated/);
    });

    it('--force overrides marker and re-copies', async () => {
      await createSrcState({ 'x': { pid: 1 } });

      const { migrateFromCcTower } = await importMigrate();
      migrateFromCcTower(); // first call — creates marker

      // Modify source to verify re-copy
      await writeFile(
        join(srcDir(), 'state.json'),
        JSON.stringify({ sessions: { 'y': { pid: 2 } } }),
      );

      const result2 = migrateFromCcTower({ force: true });
      expect(result2.migrated.state).toBe(true);
      expect(result2.skipped.reason).toBeUndefined();

      const copied = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      expect(copied.sessions['y']).toBeDefined();
    });

    it('refuses when destination has data and no marker, no --force', async () => {
      await createSrcState({ 'src-sess': { pid: 1 } });
      // Pre-create destination with different data (no marker)
      await mkdir(dstDir(), { recursive: true });
      await writeFile(
        join(dstDir(), 'state.json'),
        JSON.stringify({ sessions: { 'dst-sess': { pid: 99 } } }),
      );

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      // state should NOT be overwritten
      expect(result.migrated.state).toBe(false);
      expect(result.warnings.some(w => w.includes('state.json') && w.includes('--force'))).toBe(true);

      // Original destination content preserved
      const dst = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      expect(dst.sessions['dst-sess']).toBeDefined();
      expect(dst.sessions['src-sess']).toBeUndefined();
    });

    it('warns about legacy plugin directory', async () => {
      await createSrcState({});
      await mkdir(pluginDir(), { recursive: true });

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      expect(result.warnings.some(w => w.includes('install-hooks'))).toBe(true);
    });

    it('dryRun: reports what would happen without changing files', async () => {
      await createSrcState({ 'z': { pid: 5 } });

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower({ dryRun: true });

      // Reports as if it would migrate
      expect(result.migrated.state).toBe(true);
      // But no actual files created
      expect(existsSync(join(dstDir(), 'state.json'))).toBe(false);
      expect(existsSync(marker())).toBe(false);
    });

    it('skips gracefully when source directory does not exist', async () => {
      // No srcDir created
      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      expect(result.migrated.state).toBe(false);
      expect(result.skipped.reason).toMatch(/source directory/);
    });

    it('fills agentId in both sessions and instances when both present', async () => {
      await mkdir(srcDir(), { recursive: true });
      const content = {
        version: 2,
        sessions: {
          'sess-1': { pid: 1, status: 'idle' },
          'sess-2': { pid: 2, status: 'busy', agentId: 'existing' },
        },
        instances: {
          'inst-1': { pid: 3, status: 'idle' },
          'inst-2': { pid: 4, status: 'idle', agentId: 'already' },
        },
        displayOrder: ['sess-1', 'sess-2'],
      };
      await writeFile(join(srcDir(), 'state.json'), JSON.stringify(content, null, 2));

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      // sess-1 and inst-1 lack agentId → 2 filled
      expect(result.migrated.agentIdFilled).toBe(2);

      const copied = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      expect(copied.sessions['sess-1'].agentId).toBe('claude');
      expect(copied.sessions['sess-2'].agentId).toBe('existing');
      expect(copied.instances['inst-1'].agentId).toBe('claude');
      expect(copied.instances['inst-2'].agentId).toBe('already');
    });

    it('preserves raw structure (version, displayOrder) after agentId fill', async () => {
      await mkdir(srcDir(), { recursive: true });
      const content = {
        version: 2,
        sessions: { 's1': { pid: 1, status: 'idle' } },
        instances: { 'i1': { pid: 2, status: 'idle' } },
        displayOrder: ['s1'],
      };
      await writeFile(join(srcDir(), 'state.json'), JSON.stringify(content, null, 2));

      const { migrateFromCcTower } = await importMigrate();
      migrateFromCcTower();

      const copied = JSON.parse(await readFile(join(dstDir(), 'state.json'), 'utf8'));
      expect(copied.version).toBe(2);
      expect(copied.displayOrder).toEqual(['s1']);
      expect(copied.sessions).toBeDefined();
      expect(copied.instances).toBeDefined();
    });

    it('copies config.yaml when present', async () => {
      await createSrcState({});
      await createSrcConfig();

      const { migrateFromCcTower } = await importMigrate();
      const result = migrateFromCcTower();

      expect(result.migrated.config).toBe(true);
      expect(existsSync(join(dstDir(), 'config.yaml'))).toBe(true);
      const content = await readFile(join(dstDir(), 'config.yaml'), 'utf8');
      expect(content).toContain('cc-tower config');
    });
  });
});
