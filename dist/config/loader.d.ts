import { type Config } from './defaults.js';
/**
 * Resolve ~ to the user's home directory.
 */
export declare function expandHome(p: string): string;
/**
 * Get the default config file path: ~/.config/cc-tower/config.yaml
 */
export declare function getConfigPath(): string;
/**
 * Load config from a YAML file, deep-merging with defaults.
 * - If the file does not exist, returns defaults.
 * - If the file is malformed YAML, logs a warning and returns defaults.
 *
 * @param configPath - Optional path to the config file. Defaults to ~/.config/cc-tower/config.yaml.
 */
export declare function loadConfig(configPath?: string): Config;
