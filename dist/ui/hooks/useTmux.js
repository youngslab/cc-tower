import { useCallback } from 'react';
import { execa } from 'execa';
import { tmux } from '../../tmux/commands.js';
export function useTmux(closeKey = 'Escape') {
    // Map config key name to tmux key name
    const tmuxKey = closeKey === 'Escape' ? 'Escape' : closeKey;
    const send = useCallback(async (session, text) => {
        if (!session.paneId && !session.sshTarget)
            return false;
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
                    `tmux new-session -d -s \\$PEEK -t \\$SESS && ` +
                    `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ` +
                    `tmux attach -t \\$PEEK \\\\; select-window -t :\\$WIDX \\\\; set-option key-table cctower-peek; ` +
                    `tmux unbind-key -T cctower-peek ${tmuxKey}; tmux kill-session -t \\$PEEK 2>/dev/null`
                : `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ` +
                    `tmux attach \\\\; set-option key-table cctower-peek; ` +
                    `tmux unbind-key -T cctower-peek ${tmuxKey}`;
            // For peek, we need interactive TTY — convert "docker exec X" to "docker exec -it X"
            const interactivePrefix = session.commandPrefix?.replace(/^docker exec /, 'docker exec -it ');
            const remoteCmd = interactivePrefix
                ? `${interactivePrefix} sh -c 'export LANG=C.UTF-8; ${setupCmd.replace(/'/g, "'\\''")}'`
                : setupCmd;
            await tmux.displayPopup({
                width: '80%',
                height: '80%',
                title: ` ${session.label ?? session.projectName} (${session.host}) | ${tmuxKey} to close `,
                command: `ssh -t -o LogLevel=ERROR ${session.sshTarget} "${remoteCmd}"`,
                closeOnExit: true,
            });
            return true;
        }
        // Local peek: use session group to avoid syncing windows with the original session
        const panes = await tmux.listPanes();
        const targetPane = panes.find(p => p.paneId === session.paneId);
        if (!targetPane)
            return false;
        const peekName = `_cctower_peek_${process.pid}`;
        try {
            await tmux.killSession(peekName);
        }
        catch { }
        try {
            await tmux.newGroupSession(peekName, targetPane.sessionName);
            // Prevent peek client (smaller popup) from resizing original session's windows
            try {
                await execa('tmux', ['set-option', '-t', peekName, 'window-size', 'largest']);
            }
            catch { }
            // Set copy-command on peek session to work around display-popup blocking OSC52
            const clipCmd = 'CLIP=$(command -v xclip && echo "xclip -selection clipboard" || command -v xsel && echo "xsel --clipboard --input" || echo ""); [ -n "$CLIP" ] && tmux set-option -s copy-command "$CLIP"';
            await tmux.displayPopup({
                width: '80%',
                height: '80%',
                title: ` ${session.label ?? session.projectName} (${session.paneId}) | ${tmuxKey} to close `,
                command: `tmux bind-key -T cctower-peek ${tmuxKey} detach-client && ${clipCmd}; tmux attach -t ${peekName} \\; select-window -t :${targetPane.windowIndex} \\; set-option key-table cctower-peek`,
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