import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { agents } from '../agents/registry.js';

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
  private hookLocked: Set<number> = new Set(); // PIDs whose sessionId was corrected by hook — don't override from pid.json

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

  /** Update known sessionId for a PID — prevents discovery from overriding hook corrections */
  updateKnown(pid: number, sessionId: string): void {
    const existing = this.known.get(pid);
    if (existing) {
      existing.sessionId = sessionId;
      this.hookLocked.add(pid);
      logger.debug('discovery: updateKnown (hook-locked)', { pid, sessionId: sessionId.slice(0, 12) });
    }
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

    // If sessions dir is empty, fall back to process scanning via the
    // claude agent (Claude Code >= 2.1.77 stopped writing pid.json).
    if (jsonFiles.length === 0) {
      return this.scanProcessesViaAgent();
    }

    let active: SessionInfo[] = [];

    for (const file of jsonFiles) {
      const filePath = join(sessionsDir, file);
      const info = await agents.claude.parseSessionFile(filePath);
      if (!info) continue; // malformed / sdk-cli / /tmp — agent already filtered + logged

      const alive = isPidAlive(info.pid);
      if (!alive) {
        if (this.known.has(info.pid)) {
          const lost = this.known.get(info.pid)!;
          this.known.delete(info.pid);
          this.hookLocked.delete(info.pid);
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
          // If hook-locked, pid.json is stale — ignore this change
          if (this.hookLocked.has(info.pid)) {
            logger.debug('discovery: ignoring pid.json change for hook-locked session', { pid: info.pid, pidJson: info.sessionId, hookCorrected: prev.sessionId });
            continue;
          }
          logger.debug('discovery: session-changed', { pid: info.pid, old: prev.sessionId, new: info.sessionId });
          this.known.set(info.pid, info);
          this.emit('session-changed', { prev, next: info });
        }
      }

      active.push(info);
    }

    // Deduplicate: when multiple PIDs share the same sessionId (e.g., Claude Code reused
    // session file after /resume), keep only the most recently started PID as the session owner.
    // The older PID likely moved to a different session but its file wasn't updated.
    const bySessionId = new Map<string, SessionInfo>();
    for (const info of active) {
      const existing = bySessionId.get(info.sessionId);
      if (!existing || info.startedAt > existing.startedAt || (info.startedAt === existing.startedAt && info.pid > existing.pid)) {
        if (existing) {
          this.hookLocked.delete(existing.pid);
          logger.debug('discovery: dedup — evicting older PID with same sessionId', {
            evictedPid: existing.pid, keptPid: info.pid, sessionId: info.sessionId,
          });
        }
        bySessionId.set(info.sessionId, info);
      } else {
        logger.debug('discovery: dedup — skipping PID with older startedAt', {
          skippedPid: info.pid, keptPid: existing!.pid, sessionId: info.sessionId,
        });
      }
    }
    active = Array.from(bySessionId.values());

    // Check known PIDs that are no longer in any file
    for (const [pid, session] of this.known) {
      if (!active.find((s) => s.pid === pid)) {
        if (!isPidAlive(pid)) {
          this.known.delete(pid);
          this.hookLocked.delete(pid);
          this.emit('session-lost', session);
          logger.info('discovery: session-lost (no file, PID dead)', { pid, sessionId: session.sessionId, cwd: session.cwd });
        }
      }
    }

    return active;
  }

  /**
   * Fallback path: ask the claude agent to scan running processes, then
   * apply the same emit-and-track bookkeeping as the file-based path.
   */
  private scanProcessesViaAgent(): SessionInfo[] {
    const detected = agents.claude.scanProcesses(this.config.claude_dir, (cwd, pid) => {
      return new Set(
        Array.from(this.known.values())
          .filter(s => s.cwd === cwd && s.pid !== pid)
          .map(s => s.sessionId),
      );
    });

    const active: SessionInfo[] = [];
    for (const info of detected) {
      if (!this.known.has(info.pid)) {
        this.known.set(info.pid, info);
        this.emit('session-found', info);
        logger.debug('discovery: session-found (process scan)', { pid: info.pid, cwd: info.cwd });
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
    return active;
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false; // PID 0 sends signal to process group — treat as not alive
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
