/**
 * Run `fn` while holding an exclusive lock for the given host.
 *
 * Throws if the lock cannot be acquired within the timeout.
 *
 * @param host       - host name (used as lock identity)
 * @param fn         - async function to execute while holding the lock
 * @param opts.timeoutMs - override default acquire timeout (mainly for tests)
 */
export declare function withHostLock<T>(host: string, fn: () => Promise<T>, opts?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<T>;
/**
 * Exposed for tests and operator tooling — returns the lock path that
 * `withHostLock(host, …)` would use.
 */
export declare function _lockPathForTest(host: string): string;
