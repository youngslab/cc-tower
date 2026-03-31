import { useCallback } from 'react';
import { execa } from 'execa';
import stringWidth from 'string-width';
import { tmux } from '../../tmux/commands.js';
import { mapPidToPane } from '../../tmux/pane-mapper.js';
function truncateWidth(str, max) {
    if (stringWidth(str) <= max)
        return str;
    let result = '';
    let w = 0;
    for (const ch of str) {
        const cw = stringWidth(ch);
        if (w + cw > max - 1)
            break;
        result += ch;
        w += cw;
    }
    return result + '…';
}
function peekTitle(session, closeHint) {
    const name = session.label ? `[${session.label}] ${session.projectName}` : session.projectName;
    const loc = session.sshTarget ? session.host : (session.paneId ?? '');
    const goal = session.goalSummary ?? session.contextSummary ?? '';
    const goalPart = goal ? ` — ${truncateWidth(goal, 60)}` : '';
    return ` ${name} (${loc})${goalPart} | ${closeHint} to close `;
}
export function useTmux(closeKey = 'Escape') {
    // Map config key name to tmux key name
    const tmuxKey = closeKey === 'Escape' ? 'Escape' : closeKey;
    const send = useCallback(async (session, text) => {
        if (!session.paneId && !session.sshTarget) {
            const mapping = await mapPidToPane(session.pid);
            if (!mapping.paneId)
                return false;
            session = { ...session, paneId: mapping.paneId };
        }
        if (session.sshTarget) {
            // Remote send via SSH
            const escaped = text.replace(/'/g, "'\\''");
            const { spawn } = await import('node:child_process');
            return new Promise((resolve) => {
                const innerCmd = `tmux send-keys -t ${session.paneId} '${escaped}' Enter`;
                const remoteCmd = session.commandPrefix
                    ? `${session.commandPrefix} sh -c '${innerCmd.replace(/'/g, "'\\''")}'`
                    : innerCmd;
                const cmd = `ssh ${session.sshTarget} "${remoteCmd.replace(/"/g, '\\"')}"`;
                const child = spawn('sh', ['-c', cmd], { stdio: 'ignore' });
                child.on('close', (code) => resolve(code === 0));
                child.on('error', () => resolve(false));
            });
        }
        if (!session.paneId)
            return false;
        await tmux.sendKeys(session.paneId, text);
        return true;
    }, []);
    const peek = useCallback(async (session) => {
        if (session.sshTarget) {
            // Remote peek: ssh into host, create group session, attach to specific pane
            const paneSelect = session.paneId
                ? `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index}' | grep '^${session.paneId} ' | head -1`
                : '';
            const setupCmd = session.paneId
                ? `PINFO=\\$(${paneSelect}); SESS=\\$(echo \\$PINFO | awk '{print \\$2}'); WIDX=\\$(echo \\$PINFO | awk '{print \\$3}'); ` +
                    `PEEK=_cctower_peek_\\$\\$; tmux kill-session -t \\$PEEK 2>/dev/null; ` +
                    `DEFWIN=\\$(tmux new-session -d -s \\$PEEK -PF '#{window_id}') && ` +
                    `tmux link-window -s \\$SESS:\\$WIDX -t \\$PEEK:99 && ` +
                    `tmux kill-window -t \\$DEFWIN && ` +
                    `tmux set-option -t \\$PEEK aggressive-resize on 2>/dev/null; ` +
                    `tmux set-option -t \\$PEEK status off && ` +
                    `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ` +
                    `TMUX= tmux attach -t \\$PEEK \\\\; set-option key-table cctower-peek; ` +
                    `tmux unbind-key -T cctower-peek ${tmuxKey}; tmux kill-session -t \\$PEEK 2>/dev/null`
                : `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ` +
                    `tmux attach \\\\; set-option key-table cctower-peek; ` +
                    `tmux unbind-key -T cctower-peek ${tmuxKey}`;
            // For peek, tmux is always on the SSH host — commandPrefix (e.g. "docker exec devenv")
            // is for running Claude inside a container, NOT for host-level tmux operations.
            const remoteCmd = setupCmd;
            await tmux.displayPopup({
                width: '80%',
                height: '80%',
                title: peekTitle(session, tmuxKey),
                command: `ssh -t -o LogLevel=ERROR ${session.sshTarget} "${remoteCmd}"`,
                closeOnExit: true,
            });
            return true;
        }
        // Local peek: use session group to avoid syncing windows with the original session
        // Resolve paneId on-demand if it wasn't set at registration time
        let resolvedPaneId = session.paneId;
        if (!resolvedPaneId) {
            const mapping = await mapPidToPane(session.pid);
            resolvedPaneId = mapping.paneId;
        }
        const panes = await tmux.listPanes();
        const targetPane = panes.find(p => p.paneId === resolvedPaneId);
        if (!targetPane)
            return false;
        const peekName = `_cctower_peek_${process.pid}`;
        try {
            await tmux.killSession(peekName);
        }
        catch { }
        try {
            // Create isolated session with only the target window (not a full session group)
            const { stdout: defaultWindowId } = await execa('tmux', [
                'new-session', '-d', '-s', peekName, '-PF', '#{window_id}',
            ]);
            const targetWindow = `${targetPane.sessionName}:${targetPane.windowIndex}`;
            await execa('tmux', ['link-window', '-s', targetWindow, '-t', `${peekName}:99`]);
            await execa('tmux', ['kill-window', '-t', defaultWindowId.trim()]);
            // Allow popup to have its own size independent of original session
            try {
                await execa('tmux', ['set-option', '-g', '-t', peekName, 'aggressive-resize', 'on']);
            }
            catch { }
            await execa('tmux', ['set-option', '-t', peekName, 'status', 'off']);
            // Set copy-command on peek session to work around display-popup blocking OSC52
            const clipCmd = 'CLIP=$(command -v xclip && echo "xclip -selection clipboard" || command -v xsel && echo "xsel --clipboard --input" || echo ""); [ -n "$CLIP" ] && tmux set-option -s copy-command "$CLIP"';
            await tmux.displayPopup({
                width: '80%',
                height: '80%',
                title: peekTitle(session, tmuxKey),
                command: `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ${clipCmd}; TMUX= tmux attach -t ${peekName} \\; set-option key-table cctower-peek`,
                closeOnExit: true,
            });
        }
        catch { }
        try {
            await tmux.killSession(peekName);
        }
        catch { }
        return true;
    }, []);
    return { send, peek };
}
//# sourceMappingURL=useTmux.js.map