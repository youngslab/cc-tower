/**
 * Manages SSH reverse tunnels for socket forwarding (hooks: true hosts).
 */
export declare class ConnectionManager {
    private tunnels;
    private healthTimer;
    /**
     * Start a reverse tunnel for socket forwarding.
     * ssh -fN -R <remote_socket>:<local_socket> <host>
     */
    startTunnel(hostName: string, sshTarget: string, localSocket: string, sshOptions?: string): Promise<boolean>;
    /**
     * Start health checking every 30 seconds.
     * Reconnects unhealthy tunnels.
     */
    startHealthCheck(localSocket: string): void;
    /**
     * Check if a host has a healthy tunnel.
     */
    isHealthy(hostName: string): boolean;
    /**
     * Stop all tunnels and health checking.
     */
    stopAll(): void;
}
