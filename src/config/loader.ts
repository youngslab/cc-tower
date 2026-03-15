import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { defaults, type Config } from './defaults.js';

/**
 * Resolve ~ to the user's home directory.
 */
export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Get the default config file path: ~/.config/cc-tower/config.yaml
 */
export function getConfigPath(): string {
  return join(homedir(), '.config', 'cc-tower', 'config.yaml');
}

/**
 * Recursively merge `override` into `base`, returning a new object.
 * Only plain objects are merged; arrays and primitives are replaced.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key as string] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      result[key as string] = overrideVal;
    }
  }
  return result as T;
}

/**
 * Load config from a YAML file, deep-merging with defaults.
 * - If the file does not exist, returns defaults.
 * - If the file is malformed YAML, logs a warning and returns defaults.
 *
 * @param configPath - Optional path to the config file. Defaults to ~/.config/cc-tower/config.yaml.
 */
export function loadConfig(configPath?: string): Config {
  const resolvedPath = expandHome(configPath ?? getConfigPath());

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err: unknown) {
    // File not found — silently use defaults
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...defaults } as Config;
    }
    // Other read error — warn and use defaults
    console.warn(`[cc-tower] Failed to read config file at ${resolvedPath}:`, err);
    return { ...defaults } as Config;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    console.warn(`[cc-tower] Malformed YAML in config file ${resolvedPath}:`, err);
    return { ...defaults } as Config;
  }

  if (parsed === null || parsed === undefined) {
    return { ...defaults } as Config;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[cc-tower] Config file ${resolvedPath} must be a YAML mapping, got ${typeof parsed}. Using defaults.`);
    return { ...defaults } as Config;
  }

  return deepMerge(defaults as unknown as Record<string, unknown>, parsed as Record<string, unknown>) as unknown as Config;
}
