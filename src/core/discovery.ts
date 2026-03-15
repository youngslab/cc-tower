import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export interface DiscoveryConfig {
  scan_interval: number; // ms
  claude_dir: string;    // ~/.claude
}

export class DiscoveryEngine extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private known: Map<number, SessionInfo> = new Map();

  constructor(private config: DiscoveryConfig) {
    super();
  }

  start(): void {
    if (this.interval !== null) return;
    void this.scanOnce();
    this.interval = setInterval(() => {
      void this.scanOnce();
    }, this.config.scan_interval);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async scanOnce(): Promise<SessionInfo[]> {
    const sessionsDir = join(this.config.claude_dir, 'sessions');
    let files: string[] = [];

    try {
      files = await readdir(sessionsDir);
    } catch (err) {
      logger.debug('discovery: could not read sessions dir', { sessionsDir, err: String(err) });
      return [];
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const active: SessionInfo[] = [];

    for (const file of jsonFiles) {
      const filePath = join(sessionsDir, file);
      let info: SessionInfo;

      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!isSessionInfo(parsed)) {
          logger.debug('discovery: malformed session file', { filePath });
          continue;
        }
        info = parsed;
      } catch (err) {
        logger.debug('discovery: failed to read/parse session file', { filePath, err: String(err) });
        continue;
      }

      const alive = isPidAlive(info.pid);
      if (!alive) {
        if (this.known.has(info.pid)) {
          const lost = this.known.get(info.pid)!;
          this.known.delete(info.pid);
          this.emit('session-lost', lost);
          logger.debug('discovery: session-lost (PID dead)', { pid: info.pid });
        }
        continue;
      }

      if (!this.known.has(info.pid)) {
        this.known.set(info.pid, info);
        this.emit('session-found', info);
        logger.debug('discovery: session-found', { pid: info.pid, sessionId: info.sessionId });
      }

      active.push(info);
    }

    // Check known PIDs that are no longer in any file
    for (const [pid, session] of this.known) {
      if (!active.find((s) => s.pid === pid)) {
        if (!isPidAlive(pid)) {
          this.known.delete(pid);
          this.emit('session-lost', session);
          logger.debug('discovery: session-lost (no file)', { pid });
        }
      }
    }

    return active;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSessionInfo(val: unknown): val is SessionInfo {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v['pid'] === 'number' &&
    typeof v['sessionId'] === 'string' &&
    typeof v['cwd'] === 'string' &&
    typeof v['startedAt'] === 'number'
  );
}
