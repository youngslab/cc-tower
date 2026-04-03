import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  host?: string;        // undefined = local
  sshTarget?: string;   // undefined = local
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

    // If sessions dir is empty, fall back to process scanning
    if (jsonFiles.length === 0) {
      return this.scanProcesses();
    }

    const active: SessionInfo[] = [];

    for (const file of jsonFiles) {
      const filePath = join(sessionsDir, file);
      let info: SessionInfo;

      try {
        const raw = await readFile(filePath, 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // File may have trailing garbage after the JSON object — extract the first object
          const end = raw.indexOf('}');
          if (end === -1) throw new Error('no closing brace found');
          parsed = JSON.parse(raw.slice(0, end + 1));
        }
        if (!isSessionInfo(parsed)) {
          logger.debug('discovery: malformed session file', { filePath });
          continue;
        }
        // Skip sdk-cli sessions (headless subprocesses spawned by user code, not interactive terminals)
        if ((parsed as unknown as Record<string, unknown>)['entrypoint'] === 'sdk-cli') {
          logger.debug('discovery: skipping sdk-cli session', { filePath });
          continue;
        }
        info = parsed;
      } catch (err) {
        logger.debug('discovery: failed to read/parse session file', { filePath, err: String(err) });
        continue;
      }

      // Skip /tmp sessions (ephemeral subprocesses, LLM summarizer, etc.)
      if (info.cwd.startsWith('/tmp')) {
        logger.debug('discovery: skipping /tmp session', { filePath, cwd: info.cwd });
        continue;
      }

      const alive = isPidAlive(info.pid);
      if (!alive) {
        if (this.known.has(info.pid)) {
          const lost = this.known.get(info.pid)!;
          this.known.delete(info.pid);
          this.emit('session-lost', lost);
          logger.info('discovery: session-lost (PID dead)', { pid: info.pid, sessionId: info.sessionId, cwd: info.cwd });
        }
        continue;
      }

      if (!this.known.has(info.pid)) {
        this.known.set(info.pid, info);
        this.emit('session-found', info);
        logger.debug('discovery: session-found', { pid: info.pid, sessionId: info.sessionId });
      } else {
        // Detect sessionId change (e.g., /resume, /clear)
        const prev = this.known.get(info.pid)!;
        if (prev.sessionId !== info.sessionId) {
          logger.debug('discovery: session-changed', { pid: info.pid, old: prev.sessionId, new: info.sessionId });
          this.known.set(info.pid, info);
          this.emit('session-changed', { prev, next: info });
        }
      }

      active.push(info);
    }

    // Check known PIDs that are no longer in any file
    for (const [pid, session] of this.known) {
      if (!active.find((s) => s.pid === pid)) {
        if (!isPidAlive(pid)) {
          this.known.delete(pid);
          this.emit('session-lost', session);
          logger.info('discovery: session-lost (no file, PID dead)', { pid, sessionId: session.sessionId, cwd: session.cwd });
        }
      }
    }

    return active;
  }

  /**
   * Fallback: discover Claude sessions by scanning running processes.
   * Used when ~/.claude/sessions/ is empty (Claude Code >= 2.1.77).
   */
  private scanProcesses(): SessionInfo[] {
    const active: SessionInfo[] = [];
    try {
      // Find all 'claude' processes with a CWD
      const out = execSync(
        "ps -eo pid,comm | grep '^[[:space:]]*[0-9].*claude$' | awk '{print $1}'",
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
      if (!out) return active;

      for (const pidStr of out.split('\n')) {
        const pid = parseInt(pidStr.trim());
        if (isNaN(pid)) continue;

        // Get CWD from /proc
        let cwd: string;
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch { continue; }
        if (!cwd) continue;

        // Skip temporary/ephemeral claude processes (e.g., claude --print from /tmp)
        if (cwd === '/tmp' || cwd.startsWith('/tmp/')) continue;

        // Only include if we have a matching project directory in claude_dir
        const slug = cwdToSlug(cwd);
        const projectDir = join(this.config.claude_dir, 'projects', slug);
        try { readdirSync(projectDir); } catch { continue; } // no project dir = not a tracked session

        let sessionId = `proc-${pid}`;

        // 1. Try to get CLAUDE_SESSION_ID from process environment (highest priority)
        try {
          const environPath = `/proc/${pid}/environ`;
          const environData = readFileSync(environPath, 'utf-8');
          const environ = environData.split('\0');
          const claudeSessionIdEntry = environ.find(entry => entry.startsWith('CLAUDE_SESSION_ID='));
          if (claudeSessionIdEntry) {
            sessionId = claudeSessionIdEntry.replace('CLAUDE_SESSION_ID=', '');
          }
        } catch {}

        // 2. Fallback: use JSONL filename if CLAUDE_SESSION_ID not found
        if (sessionId.startsWith('proc-')) {
          try {
            const jsonls = readdirSync(projectDir)
              .filter(f => f.endsWith('.jsonl'))
              .map(f => { try { return { name: f, mtime: statSync(join(projectDir, f)).mtimeMs }; } catch { return { name: f, mtime: 0 }; } })
              .sort((a, b) => b.mtime - a.mtime);
            if (jsonls.length > 0) {
              sessionId = jsonls[0]!.name.replace('.jsonl', '');
            }
          } catch {}
        }

        const info: SessionInfo = {
          pid,
          sessionId,
          cwd,
          startedAt: Date.now(),
        };

        if (!this.known.has(pid)) {
          this.known.set(pid, info);
          this.emit('session-found', info);
          logger.debug('discovery: session-found (process scan)', { pid, cwd });
        }
        active.push(info);
      }

      // Check for dead processes
      for (const [pid, session] of this.known) {
        if (!active.find(s => s.pid === pid) && !isPidAlive(pid)) {
          this.known.delete(pid);
          this.emit('session-lost', session);
        }
      }
    } catch (err) {
      logger.debug('discovery: process scan failed', { error: String(err) });
    }
    return active;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means process exists but we lack permission — treat as alive
    if (err?.code === 'EPERM') {
      logger.debug('discovery: isPidAlive EPERM (treating as alive)', { pid });
      return true;
    }
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
