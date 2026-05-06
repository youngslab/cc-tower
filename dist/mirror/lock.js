/**
 * Per-host lock to serialize concurrent mirror operations.
 *
 * Two `popmux mirror --host server-a ...` invocations racing each other could
 * both decide "no live mirror exists" and both create a new window, leaving
 * the user with two duplicate ssh sessions. Holding a per-host lock around
 * the cleanup → check → create → switch sequence makes the operation atomic.
 *
 * Implementation: Node has no native `flock(2)` binding, so we use the
 * O_EXCL file-creation pattern as a portable advisory lock:
 *   - `fs.openSync(<path>, 'wx')` succeeds only if the file does not exist.
 *   - The owner removes the file in `finally`.
 *   - Other callers retry with backoff until the file disappears or timeout.
 *
 * Stale locks are tolerated: if a previous holder crashed without unlinking,
 * the next caller will block until timeout. We accept this trade-off because
 * (a) crashes are rare, (b) the user can manually `rm` the lock, and (c) we
 * don't want to mistakenly steal a lock from a slow but live process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
const LOCK_DIR = path.join(process.env['XDG_RUNTIME_DIR'] || '/tmp', 'popmux');
const ACQUIRE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
function lockPath(host) {
    // Slug the host name to be filesystem-safe.
    const slug = host.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(LOCK_DIR, `mirror.${slug}.lock`);
}
/**
 * Run `fn` while holding an exclusive lock for the given host.
 *
 * Throws if the lock cannot be acquired within the timeout.
 *
 * @param host       - host name (used as lock identity)
 * @param fn         - async function to execute while holding the lock
 * @param opts.timeoutMs - override default acquire timeout (mainly for tests)
 */
export async function withHostLock(host, fn, opts) {
    fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
    const lock = lockPath(host);
    const timeout = opts?.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
    const poll = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
    const start = Date.now();
    let fd = null;
    while (fd === null) {
        try {
            fd = fs.openSync(lock, 'wx');
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            if (Date.now() - start >= timeout) {
                throw new Error(`Timed out acquiring mirror lock for host "${host}" (${lock})`);
            }
            await new Promise((r) => setTimeout(r, poll));
        }
    }
    try {
        return await fn();
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch { }
        try {
            fs.unlinkSync(lock);
        }
        catch { }
    }
}
/**
 * Exposed for tests and operator tooling — returns the lock path that
 * `withHostLock(host, …)` would use.
 */
export function _lockPathForTest(host) {
    return lockPath(host);
}
//# sourceMappingURL=lock.js.map