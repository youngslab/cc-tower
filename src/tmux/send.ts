import { tmux } from './commands.js';

export async function sendToPane(paneId: string, text: string): Promise<void> {
  await tmux.sendKeys(paneId, text);
}
