import { sshExec } from './exec.js';
import { logger } from '../utils/logger.js';

export interface RemoteHostConfig {
  sshTarget: string;
  sshOptions?: string;
  claudeDir?: string;  // default: '~/.claude'
  commandPrefix?: string; // prefix to wrap remote commands, e.g., 'docker exec devenv'
}

/**
 * List all tmux panes on a remote host.
 */
export async function remoteListPanes(host: RemoteHostConfig): Promise<Array<{
  paneId: string;
  tty: string;
  pid: number;
  sessionName: string;
  windowIndex: number;
}>> {
  try {
    const format = '#{pane_id}|||#{pane_tty}|||#{pane_pid}|||#{session_name}|||#{window_index}';
    const out = await sshExec(host.sshTarget, `tmux list-panes -a -F '${format}'`, { sshOptions: host.sshOptions, commandPrefix: host.commandPrefix });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [paneId, tty, pidStr, sessionName, windowIdx] = line.split('|||');
      return {
        paneId: paneId ?? '',
        tty: tty ?? '',
        pid: parseInt(pidStr ?? '0'),
        sessionName: sessionName ?? '',
        windowIndex: parseInt(windowIdx ?? '0'),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Read session files from remote ~/.claude/sessions/
 */
export async function remoteReadSessions(host: RemoteHostConfig): Promise<string> {
  const claudeDir = host.claudeDir ?? '~/.claude';
  return sshExec(host.sshTarget, `cat ${claudeDir}/sessions/*.json 2>/dev/null || true`, { sshOptions: host.sshOptions, commandPrefix: host.commandPrefix });
}

/**
 * Read tail of a remote JSONL file.
 */
export async function remoteReadJsonlTail(host: RemoteHostConfig, jsonlPath: string, bytes: number = 262144): Promise<string> {
  return sshExec(host.sshTarget, `tail -c ${bytes} ${jsonlPath} 2>/dev/null || true`, {
    sshOptions: host.sshOptions,
    commandPrefix: host.commandPrefix,
    timeout: 15000,
  });
}

/**
 * Send keys to a remote tmux pane.
 */
export async function remoteSendKeys(host: RemoteHostConfig, paneId: string, text: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''");
  await sshExec(host.sshTarget, `tmux send-keys -t ${paneId} '${escaped}' Enter`, { sshOptions: host.sshOptions, commandPrefix: host.commandPrefix });
}

/**
 * Check if tmux is available on remote host.
 */
export async function remoteTmuxAvailable(host: RemoteHostConfig): Promise<boolean> {
  try {
    await sshExec(host.sshTarget, 'tmux info', { timeout: 5000, sshOptions: host.sshOptions, commandPrefix: host.commandPrefix });
    return true;
  } catch {
    return false;
  }
}
