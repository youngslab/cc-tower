/**
 * Legacy cc-tower plugin handling — Plan v2 §3.4 / C4.
 *
 * When `popmux install-hooks` runs, any pre-existing v1 plugin at
 * `~/.claude/plugins/cc-tower/plugin.json` is renamed to `plugin.json.disabled`
 * so Claude Code stops loading the legacy hook entrypoint. The directory is
 * left in place — users opt into rm/nuke separately if they want a clean slate.
 *
 * Idempotent:
 *   - If plugin.json already absent, it is a no-op.
 *   - If plugin.json.disabled already exists from a previous run and a new
 *     plugin.json appears (e.g. user reinstalled v1), the existing disabled
 *     marker is overwritten so the live plugin.json is the one that gets
 *     disabled — never a stale half-disabled state.
 *
 * The `homeDir` argument is injectable for unit tests; production callers
 * pass undefined and we resolve from `os.homedir()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DisableResult {
  /** Path that was inspected (whether or not we acted). */
  pluginJsonPath: string;
  /** Path of the resulting `.disabled` marker, if any. */
  disabledPath: string;
  /** True iff we actually performed a rename in this call. */
  disabled: boolean;
  /** True iff a `.disabled` marker already exists (regardless of whether we acted). */
  alreadyDisabled: boolean;
}

/**
 * Disable the legacy cc-tower Claude plugin if present. Returns metadata
 * describing the action taken. Stderr message is written when a rename
 * actually happens, matching the behavior described in plan v2 §3.4.
 */
export function disableLegacyCcTowerPlugin(homeDir?: string): DisableResult {
  const home = homeDir ?? os.homedir();
  const pluginDir = path.join(home, '.claude', 'plugins', 'cc-tower');
  const pluginJson = path.join(pluginDir, 'plugin.json');
  const disabled = path.join(pluginDir, 'plugin.json.disabled');

  const alreadyDisabled = fs.existsSync(disabled);
  const livePresent = fs.existsSync(pluginJson);

  if (!livePresent) {
    // Nothing to do — either fresh install or already-disabled state.
    return {
      pluginJsonPath: pluginJson,
      disabledPath: disabled,
      disabled: false,
      alreadyDisabled,
    };
  }

  // If both live + disabled exist (e.g. user reinstalled v1 plugin after a
  // previous popmux install-hooks), drop the stale marker first so rename
  // doesn't fail with EEXIST on filesystems where rename-over-existing is
  // not atomic-safe.
  if (alreadyDisabled) {
    try { fs.unlinkSync(disabled); } catch {}
  }

  fs.renameSync(pluginJson, disabled);
  process.stderr.write(
    `Disabled legacy cc-tower plugin at ${pluginDir}/. Hooks will now route via popmux.\n`,
  );

  return {
    pluginJsonPath: pluginJson,
    disabledPath: disabled,
    disabled: true,
    alreadyDisabled,
  };
}
