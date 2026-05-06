/**
 * Naming helpers shared across the mirror subsystem.
 *
 * Centralises slug/unslug logic that was previously duplicated between
 * window-manager.ts and activity.ts.
 */
/**
 * Slug a paneId for use in tmux window names and filesystem paths. tmux window
 * names cannot contain '%' or '#' (format-string meaning). We replace `%` with
 * `pct` and collapse other non-word chars to `_`.
 *
 * Examples: '%5' → 'pct5'   '%12' → 'pct12'
 */
export declare function slugPaneId(pane: string): string;
/** Inverse of slugPaneId — best-effort. 'pct5' → '%5'. Other slugs returned as-is. */
export declare function unslugPaneId(slug: string): string;
/** Slug a host name for filesystem / tmux use. */
export declare function slugHost(host: string): string;
/** Compose the tmux window name for (host, pane). */
export declare function windowName(host: string, pane: string): string;
/**
 * Parse a window name back to (host, pane). Returns null if the name does not
 * follow the `mirror-<host>-<paneSlug>` pattern. Host names containing hyphens
 * are recovered correctly by anchoring on the trailing paneSlug pattern.
 */
export declare function parseWindowName(name: string): {
    host: string;
    pane: string;
} | null;
