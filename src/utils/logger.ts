const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function getConfiguredLevel(): Level {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw in LEVELS) return raw as Level;
  return 'info';
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[getConfiguredLevel()];
}

function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = { ts, level, msg };
  if (data !== undefined) entry['data'] = data;
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    log('debug', msg, data);
  },
  info(msg: string, data?: Record<string, unknown>): void {
    log('info', msg, data);
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    log('warn', msg, data);
  },
  error(msg: string, data?: Record<string, unknown>): void {
    log('error', msg, data);
  },
};
