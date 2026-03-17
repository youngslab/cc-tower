/**
 * Install hook plugin on a remote host via SCP + SSH.
 */
export declare function installRemoteHooks(sshTarget: string, sshOptions?: string): Promise<{
    success: boolean;
    message: string;
}>;
