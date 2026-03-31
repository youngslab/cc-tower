import { EventEmitter } from 'node:events';
import { remoteReadSessions, RemoteHostConfig } from './remote-commands.js';
import { sshExec } from './exec.js';
import { logger } from '../utils/logger.js';

export interface RemoteSessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  host: string;
  sshTarget: string;
}

/**
 * Discovers Claude Code sessions on remote hosts via SSH.
 */
export class RemoteDiscovery extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private known: Map<string, RemoteSessionInfo> = new Map(); // key: host::sessionId

  constructor(private hosts: Array<{ name: string; config: RemoteHostConfig }>) {
    super();
  }

  /**
   * Pre-populate known sessions (e.g. from restored state.json) so the first scan
   * correctly emits session-lost for sessions whose PIDs died (e.g. server reboot).
   */
  addKnown(session: RemoteSessionInfo): void {
    const key = `${session.host}::${session.sessionId}`;
    if (!this.known.has(key)) {
      this.known.set(key, session);
    }
  }

  start(pollInterval: number = 5000): void {
    if (this.interval) return;
    void this.scanAll();
    this.interval = setInterval(() => void this.scanAll(), pollInterval);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async scanAll(): Promise<void> {
    await Promise.all(this.hosts.map(h => this.scanHost(h.name, h.config)));
  }

  private async scanHost(hostName: string, config: RemoteHostConfig): Promise<void> {
    let raw: string;
    try {
      raw = await remoteReadSessions(config);
    } catch (err) {
      logger.debug('remote-discovery: scan failed', { host: hostName, error: String(err) });
      this.emit('host-offline', hostName);
      return;
    }

    this.emit('host-online', hostName);

    // Parse concatenated JSON objects (cat *.json outputs them back to back)
    const sessions: RemoteSessionInfo[] = [];
    // Each file is a separate JSON object, split by }{ pattern
    const jsonStrings = raw.replace(/\}\s*\{/g, '}|||{').split('|||');

    for (const str of jsonStrings) {
      try {
        const data = JSON.parse(str.trim()) as Record<string, unknown>;
        if (data['pid'] && data['sessionId'] && data['cwd']) {
          sessions.push({
            pid: data['pid'] as number,
            sessionId: data['sessionId'] as string,
            cwd: data['cwd'] as string,
            startedAt: (data['startedAt'] as number | undefined) ?? Date.now(),
            host: hostName,
            sshTarget: config.sshTarget,
          });
        }
      } catch {}
    }

    // Filter out sessions whose PID is no longer alive (e.g. after server reboot).
    // Session JSON files persist on disk but the processes don't survive reboots.
    if (sessions.length > 0) {
      const pids = sessions.map(s => s.pid).join(' ');
      const checkCmd = `for pid in ${pids}; do kill -0 $pid 2>/dev/null && echo $pid; done`;
      try {
        const aliveOut = await sshExec(config.sshTarget, checkCmd, { sshOptions: config.sshOptions, commandPrefix: config.commandPrefix, timeout: 5000 });
        const alivePids = new Set(
          aliveOut.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n) && n > 0)
        );
        const before = sessions.length;
        sessions.splice(0, sessions.length, ...sessions.filter(s => alivePids.has(s.pid)));
        if (sessions.length < before) {
          logger.debug('remote-discovery: filtered dead PIDs', { host: hostName, before, after: sessions.length });
        }
      } catch {
        // PID check failed (SSH error, etc.) — keep all sessions to avoid false negatives
        logger.debug('remote-discovery: PID liveness check failed, keeping all sessions', { host: hostName });
      }
    }

    // Detect new/lost sessions
    const currentKeys = new Set<string>();
    for (const session of sessions) {
      const key = `${hostName}::${session.sessionId}`;
      currentKeys.add(key);
      if (!this.known.has(key)) {
        this.known.set(key, session);
        this.emit('session-found', session);
        logger.debug('remote-discovery: found', { host: hostName, sessionId: session.sessionId });
      }
    }

    // Remove stale sessions for this host
    for (const [key, session] of this.known) {
      if (session.host === hostName && !currentKeys.has(key)) {
        this.known.delete(key);
        this.emit('session-lost', session);
        logger.debug('remote-discovery: lost', { host: hostName, sessionId: session.sessionId });
      }
    }
  }
}
