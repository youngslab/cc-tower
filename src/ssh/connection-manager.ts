import { spawn, ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { logger } from '../utils/logger.js';
import { sshPing } from './exec.js';

interface TunnelInfo {
  process: ChildProcess;
  host: string;
  sshTarget: string;
  sshOptions?: string;
  healthy: boolean;
}

/**
 * Manages SSH reverse tunnels for socket forwarding (hooks: true hosts).
 */
export class ConnectionManager {
  private tunnels: Map<string, TunnelInfo> = new Map();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start a reverse tunnel for socket forwarding.
   * ssh -fN -R <remote_socket>:<local_socket> <host>
   */
  async startTunnel(hostName: string, sshTarget: string, localSocket: string, sshOptions?: string): Promise<boolean> {
    if (this.tunnels.has(hostName)) return true;

    // Check connectivity first
    const reachable = await sshPing(sshTarget, sshOptions);
    if (!reachable) {
      logger.warn('connection-manager: host unreachable', { host: hostName });
      return false;
    }

    const remoteSocket = localSocket; // same path on remote
    // Use the same ControlPath as sshExec so the tunnel becomes the ControlMaster
    // and subsequent sshExec calls reuse this connection (no extra cloudflared per call).
    const controlPath = `${tmpdir()}/cc-tower-cm-%r@%h:%p`;

    const args: string[] = [];
    if (sshOptions) args.push(...sshOptions.split(/\s+/));
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'ControlPersist=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-N',  // no command
      '-R', `${remoteSocket}:${localSocket}`,
      sshTarget,
    );

    try {
      const child = spawn('ssh', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });

      child.unref(); // don't keep Node alive for this

      const tunnel: TunnelInfo = {
        process: child,
        host: hostName,
        sshTarget,
        sshOptions,
        healthy: true,
      };

      child.on('close', (code) => {
        logger.warn('connection-manager: tunnel closed', { host: hostName, code: code ?? undefined });
        tunnel.healthy = false;
        // Kill the ControlMaster socket so next reconnect creates a fresh master
        try {
          spawn('ssh', [
            '-o', `ControlPath=${controlPath}`,
            '-O', 'exit',
            sshTarget,
          ], { stdio: 'ignore' }).unref();
        } catch {}
      });

      child.on('error', (err) => {
        logger.warn('connection-manager: tunnel error', { host: hostName, error: String(err) });
        tunnel.healthy = false;
      });

      this.tunnels.set(hostName, tunnel);
      logger.info('connection-manager: tunnel started', { host: hostName, sshTarget });
      return true;
    } catch (err) {
      logger.error('connection-manager: failed to start tunnel', { host: hostName, error: String(err) });
      return false;
    }
  }

  /**
   * Start health checking every 30 seconds.
   * Reconnects unhealthy tunnels.
   */
  startHealthCheck(localSocket: string): void {
    this.healthTimer = setInterval(() => {
      void (async () => {
        for (const [name, tunnel] of this.tunnels) {
          if (!tunnel.healthy) {
            logger.info('connection-manager: reconnecting tunnel', { host: name });
            this.tunnels.delete(name);
            await this.startTunnel(name, tunnel.sshTarget, localSocket, tunnel.sshOptions);
          }
        }
      })();
    }, 30000);
  }

  /**
   * Check if a host has a healthy tunnel.
   */
  isHealthy(hostName: string): boolean {
    return this.tunnels.get(hostName)?.healthy ?? false;
  }

  /**
   * Stop all tunnels and health checking.
   */
  stopAll(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const controlPath = `${tmpdir()}/cc-tower-cm-%r@%h:%p`;
    for (const [name, tunnel] of this.tunnels) {
      try { tunnel.process.kill(); } catch {}
      try {
        spawn('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', tunnel.sshTarget], { stdio: 'ignore' }).unref();
      } catch {}
      logger.debug('connection-manager: tunnel stopped', { host: name });
    }
    this.tunnels.clear();
  }
}
