import { execa } from 'execa';
import { tmux } from './commands.js';
export async function peekSession(opts) {
    const peekName = `_popmux_peek_${process.pid}`;
    try {
        await tmux.killSession(peekName);
    }
    catch { }
    // Create isolated session with only the target window visible.
    // 1. Create empty session and capture its default window ID
    const { stdout: defaultWindowId } = await execa('tmux', [
        'new-session', '-d', '-s', peekName, '-PF', '#{window_id}',
    ]);
    // 2. Link the target window into the peek session
    const targetWindow = `${opts.sessionName}:${opts.windowIndex}`;
    await execa('tmux', ['link-window', '-s', targetWindow, '-t', `${peekName}:99`]);
    // 3. Kill the default placeholder window, leaving only the target
    await execa('tmux', ['kill-window', '-t', defaultWindowId.trim()]);
    // 4. Hide status bar in peek session
    await execa('tmux', ['set-option', '-t', peekName, 'status', 'off']);
    await tmux.displayPopup({
        width: '80%',
        height: '80%',
        title: ` ${opts.label} (${opts.paneId}) `,
        command: `TMUX= tmux attach -t ${peekName}`,
        closeOnExit: true,
    });
    try {
        await tmux.killSession(peekName);
    }
    catch { }
}
//# sourceMappingURL=peek.js.map