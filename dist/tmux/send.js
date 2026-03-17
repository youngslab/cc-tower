import { tmux } from './commands.js';
export async function sendToPane(paneId, text) {
    await tmux.sendKeys(paneId, text);
}
//# sourceMappingURL=send.js.map