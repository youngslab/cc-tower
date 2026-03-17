import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
// TUI mode suppresses stderr logs unless LOG_LEVEL is explicitly set
let tui = false;
export function setTuiMode(enabled) { tui = enabled; }
// Log file: always writes info+ regardless of TUI mode
const LOG_DIR = join(homedir(), '.local', 'share', 'cc-tower');
const LOG_FILE = join(LOG_DIR, 'cc-tower.log');
let logFileReady = false;
function ensureLogDir() {
    if (logFileReady)
        return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        logFileReady = true;
    }
    catch { }
}
function getConfiguredLevel() {
    if (tui && !process.env['LOG_LEVEL'])
        return 'error';
    const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
    if (raw in LEVELS)
        return raw;
    return 'info';
}
function shouldLogStderr(level) {
    return LEVELS[level] >= LEVELS[getConfiguredLevel()];
}
function log(level, msg, data) {
    const ts = new Date().toISOString();
    const entry = { ts, level, msg };
    if (data !== undefined)
        entry['data'] = data;
    const line = JSON.stringify(entry) + '\n';
    // Always write info+ to log file
    if (LEVELS[level] >= LEVELS['info']) {
        ensureLogDir();
        try {
            appendFileSync(LOG_FILE, line);
        }
        catch { }
    }
    // stderr: respect TUI mode / LOG_LEVEL
    if (shouldLogStderr(level)) {
        process.stderr.write(line);
    }
}
export const logger = {
    debug(msg, data) {
        log('debug', msg, data);
    },
    info(msg, data) {
        log('info', msg, data);
    },
    warn(msg, data) {
        log('warn', msg, data);
    },
    error(msg, data) {
        log('error', msg, data);
    },
};
//# sourceMappingURL=logger.js.map