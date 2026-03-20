export interface RemoteHostConfig {
    sshTarget: string;
    sshOptions?: string;
    claudeDir?: string;
    commandPrefix?: string;
}
/**
 * List all tmux panes on a remote host.
 */
export declare function remoteListPanes(host: RemoteHostConfig): Promise<Array<{
    paneId: string;
    tty: string;
    pid: number;
    sessionName: string;
    windowIndex: number;
}>>;
/**
 * Read session files from remote ~/.claude/sessions/
 */
export declare function remoteReadSessions(host: RemoteHostConfig): Promise<string>;
/**
 * Read tail of a remote JSONL file.
 */
export declare function remoteReadJsonlTail(host: RemoteHostConfig, jsonlPath: string, bytes?: number): Promise<string>;
/**
 * Send keys to a remote tmux pane.
 */
export declare function remoteSendKeys(host: RemoteHostConfig, paneId: string, text: string): Promise<void>;
/**
 * Check if tmux is available on remote host.
 */
export declare function remoteTmuxAvailable(host: RemoteHostConfig): Promise<boolean>;
