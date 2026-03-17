const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
// TUI mode suppresses logs unless LOG_LEVEL is explicitly set
let tui = false;
export function setTuiMode(enabled) { tui = enabled; }
function getConfiguredLevel() {
    if (tui && !process.env['LOG_LEVEL'])
        return 'error';
    const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
    if (raw in LEVELS)
        return raw;
    return 'info';
}
function shouldLog(level) {
    return LEVELS[level] >= LEVELS[getConfiguredLevel()];
}
function log(level, msg, data) {
    if (!shouldLog(level))
        return;
    const ts = new Date().toISOString();
    const entry = { ts, level, msg };
    if (data !== undefined)
        entry['data'] = data;
    process.stderr.write(JSON.stringify(entry) + '\n');
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