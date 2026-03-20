/**
 * Execute a command on a remote host via SSH.
 * All SSH operations go through this helper for future ControlMaster support.
 */
export declare function sshExec(sshTarget: string, command: string, opts?: {
    timeout?: number;
    sshOptions?: string;
    commandPrefix?: string;
}): Promise<string>;
/**
 * Check if SSH connection to host works.
 */
export declare function sshPing(sshTarget: string, sshOptions?: string): Promise<boolean>;
