import { sshExec } from './exec.js';
/**
 * List all tmux panes on a remote host.
 */
export async function remoteListPanes(host) {
    try {
        const format = '#{pane_id}\\t#{pane_tty}\\t#{pane_pid}\\t#{session_name}\\t#{window_index}';
        const out = await sshExec(host.sshTarget, `tmux list-panes -a -F '${format}'`, { sshOptions: host.sshOptions });
        return out.trim().split('\n').filter(Boolean).map(line => {
            const [paneId, tty, pidStr, sessionName, windowIdx] = line.split('\t');
            return {
                paneId: paneId ?? '',
                tty: tty ?? '',
                pid: parseInt(pidStr ?? '0'),
                sessionName: sessionName ?? '',
                windowIndex: parseInt(windowIdx ?? '0'),
            };
        });
    }
    catch {
        return [];
    }
}
/**
 * Read session files from remote ~/.claude/sessions/
 */
export async function remoteReadSessions(host) {
    const claudeDir = host.claudeDir ?? '~/.claude';
    return sshExec(host.sshTarget, `cat ${claudeDir}/sessions/*.json 2>/dev/null || true`, { sshOptions: host.sshOptions });
}
/**
 * Read tail of a remote JSONL file.
 */
export async function remoteReadJsonlTail(host, jsonlPath, bytes = 262144) {
    return sshExec(host.sshTarget, `tail -c ${bytes} '${jsonlPath}' 2>/dev/null || true`, {
        sshOptions: host.sshOptions,
        timeout: 15000,
    });
}
/**
 * Send keys to a remote tmux pane.
 */
export async function remoteSendKeys(host, paneId, text) {
    const escaped = text.replace(/'/g, "'\\''");
    await sshExec(host.sshTarget, `tmux send-keys -t ${paneId} '${escaped}' Enter`, { sshOptions: host.sshOptions });
}
/**
 * Check if tmux is available on remote host.
 */
export async function remoteTmuxAvailable(host) {
    try {
        await sshExec(host.sshTarget, 'tmux info', { timeout: 5000, sshOptions: host.sshOptions });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=remote-commands.js.map