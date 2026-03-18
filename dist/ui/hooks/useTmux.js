import { useCallback } from 'react';
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
                const cmd = `ssh ${session.sshTarget} "tmux send-keys -t ${session.paneId} '${escaped}' Enter"`;
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
        if (!session.paneId)
            return false;
        if (session.sshTarget) {
            // Remote peek: display-popup → ssh -t "tmux attach"
            await tmux.displayPopup({
                width: '80%',
                height: '80%',
                title: ` ${session.label ?? session.projectName} (${session.host}) | ${tmuxKey} to close `,
                command: `ssh -t ${session.sshTarget} "tmux attach"`,
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