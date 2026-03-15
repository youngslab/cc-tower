import { tmux } from './commands.js';

export async function zoomToPane(paneId: string, targetWindowId: string): Promise<boolean> {
  const current = await tmux.getCurrentPane();
  if (!current) return false;
  const returnCmd = `resize-pane -Z \; select-window -t @${current.windowId} \; select-pane -t ${current.paneId}`;
  await tmux.bindKey('F12', returnCmd);
  if (targetWindowId !== current.windowId) {
    await tmux.selectWindow(`@${targetWindowId}`);
  }
  await tmux.selectPane(paneId);
  await tmux.toggleZoom(paneId);
  return true;
}

export async function cleanupZoomBinding(): Promise<void> {
  try { await tmux.unbindKey('F12'); } catch {}
}
