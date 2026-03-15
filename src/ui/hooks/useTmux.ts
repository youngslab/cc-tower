import { useCallback } from 'react';
import { tmux } from '../../tmux/commands.js';
import { Session } from '../../core/session-store.js';

export function useTmux() {
  const send = useCallback(async (session: Session, text: string) => {
    if (!session.paneId) return false;
    await tmux.sendKeys(session.paneId, text);
    return true;
  }, []);

  const peek = useCallback(async (session: Session) => {
    if (!session.paneId) return false;
    const current = await tmux.getCurrentPane();
    if (!current) return false;
    const sessionName = `_cctower_peek_${process.pid}`;
    try { await tmux.killSession(sessionName); } catch {}
    // Get the session name that owns the target pane
    const panes = await tmux.listPanes();
    const targetPane = panes.find(p => p.paneId === session.paneId);
    if (!targetPane) return false;
    await tmux.newGroupSession(sessionName, targetPane.sessionName);
    await tmux.displayPopup({
      width: '80%',
      height: '80%',
      title: ` ${session.label ?? session.projectName} (${session.paneId}) `,
      command: `tmux attach -t ${sessionName} \\; select-window -t :${targetPane.windowIndex}`,
    });
    try { await tmux.killSession(sessionName); } catch {}
    return true;
  }, []);

  const zoom = useCallback(async (session: Session) => {
    if (!session.paneId) return false;
    const current = await tmux.getCurrentPane();
    if (!current) return false;

    // Get target pane info
    const panes = await tmux.listPanes();
    const targetPane = panes.find(p => p.paneId === session.paneId);
    if (!targetPane) return false;

    // Register F12 return keybinding
    const returnCmd = `resize-pane -Z \\; select-window -t @${current.windowId} \\; select-pane -t ${current.paneId}`;
    await tmux.bindKey('F12', returnCmd);

    // Navigate to target and zoom
    if (targetPane.windowId !== current.windowId) {
      await tmux.selectWindow(`@${targetPane.windowId}`);
    }
    await tmux.selectPane(session.paneId);
    await tmux.toggleZoom(session.paneId);

    return true;
  }, []);

  return { send, peek, zoom };
}
