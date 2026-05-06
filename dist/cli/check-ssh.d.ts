export interface SshOption {
    host: string;
    options: Record<string, string>;
}
export declare const SSH_CONFIG_PATH: string;
export declare const RECOMMENDED: Record<string, string>;
/**
 * Very simple ssh config parser.
 * - Recognizes 'Host xxx' block starts
 * - Options within a block are case-insensitive keys
 * - Does not handle Include directives (read-only diagnostic only)
 * - Ignores comment lines (#) and blank lines
 */
export declare function parseSshConfig(content: string): SshOption[];
/**
 * Check SSH ControlMaster configuration for a given host (or all hosts).
 * Returns { ok, report } — never modifies ~/.ssh/config.
 */
export declare function checkSsh(targetHost?: string, sshConfigPath?: string): {
    ok: boolean;
    report: string;
};
