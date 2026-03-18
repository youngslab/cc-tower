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

    // Local peek: use session group to avoid syncing windows with the original session
    const panes = await tmux.listPanes();
    const targetPane = panes.find(p => p.paneId === session.paneId);
    if (!targetPane) return false;

    const peekName = `_cctower_peek_${process.pid}`;
    try { await tmux.killSession(peekName); } catch {}

    try {
      await tmux.newGroupSession(peekName, targetPane.sessionName);
      await tmux.displayPopup({
        width: '80%',
        height: '80%',
        title: ` ${session.label ?? session.projectName} (${session.paneId}) | prefix+d to close `,
        command: `tmux attach -t ${peekName} \\; select-window -t :${targetPane.windowIndex}`,
        closeOnExit: true,
      });
    } catch {}
    try { await tmux.killSession(peekName); } catch {}
    return true;
  }, []);

  return { send, peek };
}
