import { useCallback } from 'react';
import { tmux } from '../../tmux/commands.js';
import { Session } from '../../core/session-store.js';

export function useTmux() {
  const send = useCallback(async (session: Session, text: string) => {
    if (!session.paneId && !session.sshTarget) return false;
    if (session.sshTarget) {
      // Remote send via SSH
      const escaped = text.replace(/'/g, "'\\''");
      const { spawn } = await import('node:child_process');
      return new Promise<boolean>((resolve) => {
        const cmd = `ssh ${session.sshTarget} "tmux send-keys -t ${session.paneId} '${escaped}' Enter"`;
        const child = spawn('sh', ['-c', cmd], { stdio: 'ignore' });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    }
    if (!session.paneId) return false;
    await tmux.sendKeys(session.paneId, text);
    return true;
  }, []);

  const peek = useCallback(async (session: Session) => {
    if (!session.paneId) return false;

    if (session.sshTarget) {
      // Remote peek: display-popup → ssh -t "tmux attach"
      await tmux.displayPopup({
        width: '80%',
        height: '80%',
        title: ` ${session.label ?? session.projectName} (${session.host}) | prefix+d to close `,
        command: `ssh -t ${session.sshTarget} "tmux attach"`,
        closeOnExit: true,
      });
      return true;
    }

    // Local peek
    const current = await tmux.getCurrentPane();
    if (!current) return false;
    const sessionName = `_cctower_peek_${process.pid}`;

    // Clean up any stale peek sessions
    try {
      const { execSync } = await import('node:child_process');
      const sessions = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: 'utf8' });
      for (const name of sessions.trim().split('\n')) {
        if (name.startsWith('_cctower_peek_')) {
          try { await tmux.killSession(name); } catch {}
        }
      }
    } catch {}

    const panes = await tmux.listPanes();
    const targetPane = panes.find(p => p.paneId === session.paneId);
    if (!targetPane) return false;
    try {
      await tmux.newGroupSession(sessionName, targetPane.sessionName);
      await tmux.displayPopup({
        width: '80%',
        height: '80%',
        title: ` ${session.label ?? session.projectName} (${session.paneId}) | prefix+d to close `,
        command: `tmux attach -d -t ${sessionName} \\; select-window -t :${targetPane.windowIndex}`,
        closeOnExit: true,
      });
    } catch {
    } finally {
      try { await tmux.killSession(sessionName); } catch {}
    }
    return true;
  }, []);

  return { send, peek };
}
