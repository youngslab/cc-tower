export declare const MIRROR_SESSION = "__popmux_mirrors";
export interface MirrorTarget {
    host: string;
    /** Remote tmux pane id, e.g. '%5'. */
    pane: string;
    /** SSH target string, e.g. 'user@server-a' or 'server-a'. */
    sshTarget: string;
}
export interface MirrorRecord {
    window: string;
    host: string;
    pane: string;
    alive: boolean;
    /** Milliseconds since last touchActivity, or null if no marker. */
    ageMs: number | null;
}
/**
 * Slug a paneId for use in a tmux window name. tmux window names cannot
 * contain '%' or '#' (they have format-string meaning). We replace `%` with
 * `pct` and disallow other non-word chars.
 *
 * Examples: '%5' → 'pct5'   '%12' → 'pct12'
 */
export declare function slugPaneId(pane: string): string;
/** Inverse of slugPaneId — best-effort. 'pct5' → '%5'. Other slugs returned as-is. */
export declare function unslugPaneId(slug: string): string;
/** Compose the window name for (host, pane). */
export declare function windowName(host: string, pane: string): string;
/**
 * Parse a window name back to (host, slug). Returns null if the name does
 * not follow the `mirror-<host>-<paneSlug>` pattern. Note: host names that
 * contain hyphens are recovered correctly by anchoring on the trailing
 * paneSlug pattern (`pct\d+` or word chars).
 */
export declare function parseWindowName(name: string): {
    host: string;
    pane: string;
} | null;
/** Idempotently ensure the `__popmux_mirrors` tmux session exists. */
export declare function ensureMirrorSession(): Promise<void>;
/**
 * Determine whether the mirror window for (host, pane) is currently alive.
 *
 * Three conditions, ALL must hold:
 *   1. tmux window with the correct name exists in `__popmux_mirrors`.
 *   2. The pane's `#{pane_dead}` is 0 (process tree still running).
 *   3. The pane has a live `ssh` somewhere in its immediate process tree.
 */
export declare function isMirrorAlive(host: string, pane: string): Promise<boolean>;
/**
 * Kill any mirror windows whose ssh is no longer alive (or whose tmux pane
 * is dead). Returns the names of removed windows.
 */
export declare function cleanupDeadMirrors(): Promise<string[]>;
/**
 * Kill any mirror windows whose last-activity is older than the TTL. The
 * window is removed even if ssh is still healthy — this is a deliberate
 * eviction policy to bound resource usage.
 */
export declare function cleanupStaleMirrors(opts?: {
    ttlMs?: number;
}): Promise<string[]>;
/**
 * Switch the current client to the mirror window for (host, pane). Creates
 * the window if it does not already exist or is dead. Updates last-activity.
 */
export declare function goToMirror(target: MirrorTarget, opts?: {
    ttlMs?: number;
}): Promise<void>;
/**
 * Return all current mirror windows with their aliveness + age. Useful for
 * `popmux mirror --list` and integration tests.
 */
export declare function listMirrors(): Promise<MirrorRecord[]>;
