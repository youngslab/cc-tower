import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
// TUI mode suppresses stderr logs unless LOG_LEVEL is explicitly set
let tui = false;
export function setTuiMode(enabled) { tui = enabled; }
// Log file: always writes info+ regardless of TUI mode
const LOG_DIR = join(homedir(), '.config', 'cc-tower');
const LOG_FILE = join(LOG_DIR, 'cc-tower.log');
let logFileReady = false;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_OLD_LOGS = 3; // keep cc-tower.log.1, .2, .3
function ensureLogDir() {
    if (logFileReady)
        return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        rotateIfNeeded();
        logFileReady = true;
    }
    catch { }
}
function rotateIfNeeded() {
    try {
        const stat = statSync(LOG_FILE);
        if (stat.size < MAX_LOG_SIZE)
            return;
        // Remove oldest
        try {
            unlinkSync(`${LOG_FILE}.${MAX_OLD_LOGS}`);
        }
        catch { }
        // Shift: .2→.3, .1→.2, current→.1
        for (let i = MAX_OLD_LOGS - 1; i >= 1; i--) {
            try {
                renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`);
            }
            catch { }
        }
        try {
            renameSync(LOG_FILE, `${LOG_FILE}.1`);
        }
        catch { }
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
    // In TUI mode, never write to stderr — it corrupts the display.
    // All logs are captured in the log file (~/.config/cc-tower/cc-tower.log).
    if (tui)
        return false;
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