import { tmux } from './commands.js';
export async function peekSession(opts) {
    const peekName = `_cctower_peek_${process.pid}`;
    try {
        await tmux.killSession(peekName);
    }
    catch { }
    await tmux.newGroupSession(peekName, opts.sessionName);
    await tmux.displayPopup({
        width: '80%',
        height: '80%',
        title: ` ${opts.label} (${opts.paneId}) `,
        command: `tmux attach -t ${peekName} \; select-window -t :${opts.windowIndex}`,
    });
    try {
        await tmux.killSession(peekName);
    }
    catch { }
}
//# sourceMappingURL=peek.js.map