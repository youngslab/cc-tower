import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function getSrcDir(): string {
  return path.join(os.homedir(), '.config', 'cc-tower');
}

function getDstDir(): string {
  return path.join(os.homedir(), '.config', 'popmux');
}

function getMarker(): string {
  return path.join(getDstDir(), '.migrated-from-cc-tower');
}

function getPluginLegacy(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'cc-tower');
}

export interface MigrateResult {
  migrated: { state: boolean; config: boolean; agentIdFilled: number };
  skipped: { reason?: string };
  warnings: string[];
  markerPath: string;
}

export function detectLegacy(): { hasSrcDir: boolean; hasMarker: boolean; hasPlugin: boolean } {
  return {
    hasSrcDir: fs.existsSync(getSrcDir()),
    hasMarker: fs.existsSync(getMarker()),
    hasPlugin: fs.existsSync(getPluginLegacy()),
  };
}

function fillAgentIds(container: Record<string, unknown> | unknown[]): number {
  const entries = Array.isArray(container) ? container : Object.values(container);
  let filled = 0;
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && !('agentId' in (entry as Record<string, unknown>))) {
      (entry as Record<string, unknown>)['agentId'] = 'claude';
      filled++;
    }
  }
  return filled;
}

function copyFile(
  src: string,
  dst: string,
  force: boolean,
  dryRun: boolean,
  warnings: string[],
  label: string,
): { copied: boolean; skippedReason?: string } {
  if (!fs.existsSync(src)) {
    return { copied: false, skippedReason: `source ${label} not found` };
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
  }

  if (fs.existsSync(dst) && !force) {
    // Destination exists without --force: refuse
    warnings.push(
      `${label}: destination ${dst} already has data and --force was not specified. ` +
      `Run with --force to overwrite, or remove the destination first.`,
    );
    return { copied: false, skippedReason: `destination ${label} exists (use --force to overwrite)` };
  }

  if (!dryRun) {
    fs.copyFileSync(src, dst);
  }
  return { copied: true };
}

export function migrateFromCcTower(opts: { force?: boolean; dryRun?: boolean } = {}): MigrateResult {
  const { force = false, dryRun = false } = opts;
  const srcDir = getSrcDir();
  const dstDir = getDstDir();
  const marker = getMarker();
  const pluginLegacy = getPluginLegacy();

  const warnings: string[] = [];
  let agentIdFilled = 0;

  // Check if already migrated (marker exists) and not forced
  if (fs.existsSync(marker) && !force) {
    return {
      migrated: { state: false, config: false, agentIdFilled: 0 },
      skipped: { reason: 'already migrated (marker exists). Use --force to re-run.' },
      warnings,
      markerPath: marker,
    };
  }

  // Source directory must exist
  if (!fs.existsSync(srcDir)) {
    return {
      migrated: { state: false, config: false, agentIdFilled: 0 },
      skipped: { reason: `source directory ${srcDir} not found — nothing to migrate` },
      warnings,
      markerPath: marker,
    };
  }

  // Migrate state.json
  const srcState = path.join(srcDir, 'state.json');
  const dstState = path.join(dstDir, 'state.json');
  const stateResult = copyFile(srcState, dstState, force, dryRun, warnings, 'state.json');

  // Fill agentId fields in migrated state.json
  if (stateResult.copied && !dryRun && fs.existsSync(dstState)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dstState, 'utf8')) as Record<string, unknown>;
      let filled = 0;

      if (raw['sessions'] !== undefined) {
        const sessionsMap = raw['sessions'] as Record<string, unknown>;
        filled += fillAgentIds(sessionsMap);
        raw['sessions'] = sessionsMap;
      }

      if (raw['instances'] !== undefined) {
        const instancesMap = raw['instances'] as Record<string, unknown>;
        filled += fillAgentIds(instancesMap);
        raw['instances'] = instancesMap;
      }

      // Fallback: if neither key exists, treat raw itself as the container
      if (raw['sessions'] === undefined && raw['instances'] === undefined) {
        filled += fillAgentIds(raw);
      }

      agentIdFilled = filled;

      // Always write back to persist agentId fields (and preserve full structure)
      fs.writeFileSync(dstState, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    } catch {
      warnings.push('state.json copied but agentId fill failed (JSON parse error)');
    }
  }

  // Migrate config.yaml
  const srcConfig = path.join(srcDir, 'config.yaml');
  const dstConfig = path.join(dstDir, 'config.yaml');
  const configResult = copyFile(srcConfig, dstConfig, force, dryRun, warnings, 'config.yaml');

  // Warn about legacy plugin directory
  if (fs.existsSync(pluginLegacy)) {
    warnings.push(
      `Legacy plugin directory detected at ${pluginLegacy}. ` +
      `Run: popmux install-hooks (or cc-tower install-hooks) to install updated hooks.`,
    );
  }

  // Write marker file
  const markerContent = JSON.stringify({
    timestamp: new Date().toISOString(),
    sourceMtime: (() => {
      try { return fs.statSync(srcDir).mtimeMs; } catch { return 0; }
    })(),
    sourceVersion: '1.x',
  }, null, 2) + '\n';

  if (!dryRun && (stateResult.copied || configResult.copied)) {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(marker, markerContent, 'utf8');
  }

  return {
    migrated: {
      state: stateResult.copied,
      config: configResult.copied,
      agentIdFilled,
    },
    skipped: {},
    warnings,
    markerPath: marker,
  };
}
