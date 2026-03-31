/**
 * Execute a command on a remote host via SSH.
 * Uses ControlMaster multiplexing to reuse connections and avoid spawning
 * a new cloudflared ProxyCommand process on every call.
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
