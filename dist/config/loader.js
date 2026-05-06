import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { defaults } from './defaults.js';
/**
 * Resolve ~ to the user's home directory.
 */
export function expandHome(p) {
    if (p === '~' || p.startsWith('~/')) {
        return join(homedir(), p.slice(1));
    }
    return p;
}
/**
 * Get the default config file path: ~/.config/popmux/config.yaml
 */
export function getConfigPath() {
    return join(homedir(), '.config', 'popmux', 'config.yaml');
}
/**
 * Recursively merge `override` into `base`, returning a new object.
 * Only plain objects are merged; arrays and primitives are replaced.
 */
function deepMerge(base, override) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
        const baseVal = base[key];
        const overrideVal = override[key];
        if (overrideVal !== null &&
            typeof overrideVal === 'object' &&
            !Array.isArray(overrideVal) &&
            baseVal !== null &&
            typeof baseVal === 'object' &&
            !Array.isArray(baseVal)) {
            result[key] = deepMerge(baseVal, overrideVal);
        }
        else if (overrideVal !== undefined) {
            result[key] = overrideVal;
        }
    }
    return result;
}
/**
 * Load config from a YAML file, deep-merging with defaults.
 * - If the file does not exist, returns defaults.
 * - If the file is malformed YAML, logs a warning and returns defaults.
 *
 * @param configPath - Optional path to the config file. Defaults to ~/.config/popmux/config.yaml.
 */
export function loadConfig(configPath) {
    const resolvedPath = expandHome(configPath ?? getConfigPath());
    let raw;
    try {
        raw = readFileSync(resolvedPath, 'utf8');
    }
    catch (err) {
        // File not found — silently use defaults
        if (err.code === 'ENOENT') {
            return { ...defaults };
        }
        // Other read error — warn and use defaults
        console.warn(`[popmux] Failed to read config file at ${resolvedPath}:`, err);
        return { ...defaults };
    }
    let parsed;
    try {
        parsed = yaml.load(raw);
    }
    catch (err) {
        console.warn(`[popmux] Malformed YAML in config file ${resolvedPath}:`, err);
        return { ...defaults };
    }
    if (parsed === null || parsed === undefined) {
        return { ...defaults };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[popmux] Config file ${resolvedPath} must be a YAML mapping, got ${typeof parsed}. Using defaults.`);
        return { ...defaults };
    }
    return deepMerge(defaults, parsed);
}
//# sourceMappingURL=loader.js.map