import { useCallback } from 'react';
import { tmux } from '../../tmux/commands.js';
import { mapPidToPane } from '../../tmux/pane-mapper.js';
export function useTmux(_closeKey = 'Escape') {
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
    return { send };
}
//# sourceMappingURL=useTmux.js.map