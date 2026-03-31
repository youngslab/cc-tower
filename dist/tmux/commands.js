import { execa } from 'execa';
const PANE_FORMAT = '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{window_id}\t#{window_index}\t#{session_name}';
function parsePaneLine(line) {
    const parts = line.split('\t');
    if (parts.length !== 11)
        return null;
    const [paneId, tty, pidStr, currentCommand, currentPath, widthStr, heightStr, activeStr, windowId, windowIndexStr, sessionName] = parts;
    const pid = parseInt(pidStr, 10);
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);
    const windowIndex = parseInt(windowIndexStr, 10);
    if (isNaN(pid) || isNaN(width) || isNaN(height) || isNaN(windowIndex))
        return null;
    return {
        paneId,
        tty,
        pid,
        currentCommand,
        currentPath,
        width,
        height,
        active: activeStr === '1',
        windowId,
        windowIndex,
        sessionName,
    };
}
export const tmux = {
    async isAvailable() {
        if (!process.env['TMUX'])
            return false;
        try {
            const result = await execa('tmux', ['info'], { reject: false });
            return result.exitCode === 0;
        }
        catch {
            return false;
        }
    },
    async listPanes() {
        let result;
        try {
            result = await execa('tmux', ['list-panes', '-a', '-F', PANE_FORMAT]);
        }
        catch (err) {
            throw new Error(`tmux list-panes failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const lines = result.stdout.split('\n').filter((l) => l.trim() !== '');
        const panes = [];
        for (const line of lines) {
            const pane = parsePaneLine(line);
            if (pane !== null)
                panes.push(pane);
        }
        return panes;
    },
    async sendKeys(paneId, text) {
        try {
            await execa('tmux', ['send-keys', '-t', paneId, text, 'Enter']);
        }
        catch (err) {
            throw new Error(`tmux send-keys to ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async displayPopup(opts) {
        const args = ['display-popup', '-w', opts.width, '-h', opts.height];
        if (opts.closeOnExit)
            args.push('-E');
        if (opts.title) {
            args.push('-T', opts.title);
        }
        args.push(opts.command);
        try {
            await execa('tmux', args);
        }
        catch (err) {
            throw new Error(`tmux display-popup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async selectPane(paneId) {
        try {
            await execa('tmux', ['select-pane', '-t', paneId]);
        }
        catch (err) {
            throw new Error(`tmux select-pane ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async selectWindow(windowTarget) {
        try {
            await execa('tmux', ['select-window', '-t', windowTarget]);
        }
        catch (err) {
            throw new Error(`tmux select-window ${windowTarget} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async newGroupSession(name, targetSession) {
        try {
            await execa('tmux', ['new-session', '-d', '-s', name, '-t', targetSession]);
        }
        catch (err) {
            throw new Error(`tmux new-session (group) ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async renameSession(target, newName) {
        try {
            await execa('tmux', ['rename-session', '-t', target, newName]);
        }
        catch (err) {
            throw new Error(`tmux rename-session ${target} → ${newName} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async killSession(name) {
        try {
            await execa('tmux', ['kill-session', '-t', name]);
        }
        catch (err) {
            throw new Error(`tmux kill-session ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async getCurrentPane() {
        try {
            const result = await execa('tmux', [
                'display-message',
                '-p',
                '#{window_id}\t#{pane_id}',
            ]);
            const parts = result.stdout.trim().split('\t');
            if (parts.length !== 2 || !parts[0] || !parts[1])
                return null;
            return { windowId: parts[0], paneId: parts[1] };
        }
        catch {
            return null;
        }
    },
    async displayMessage(message) {
        try {
            await execa('tmux', ['display-message', message]);
        }
        catch (err) {
            throw new Error(`tmux display-message failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
};
//# sourceMappingURL=commands.js.map