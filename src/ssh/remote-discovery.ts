import { EventEmitter } from 'node:events';
import { remoteReadSessions, RemoteHostConfig } from './remote-commands.js';
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
