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
export function slugPaneId(pane) {
    return pane.replace(/^%/, 'pct').replace(/[^a-zA-Z0-9_-]/g, '_');
}
/** Inverse of slugPaneId — best-effort. 'pct5' → '%5'. Other slugs returned as-is. */
export function unslugPaneId(slug) {
    return /^pct\d+$/.test(slug) ? '%' + slug.slice(3) : slug;
}
/** Slug a host name for filesystem / tmux use. */
export function slugHost(host) {
    return host.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
/** Compose the tmux window name for (host, pane). */
export function windowName(host, pane) {
    return `mirror-${slugHost(host)}-${slugPaneId(pane)}`;
}
/**
 * Parse a window name back to (host, pane). Returns null if the name does not
 * follow the `mirror-<host>-<paneSlug>` pattern. Host names containing hyphens
 * are recovered correctly by anchoring on the trailing paneSlug pattern.
 */
export function parseWindowName(name) {
    if (!name.startsWith('mirror-'))
        return null;
    const m = name.match(/^mirror-(.+?)-(pct\d+|[a-zA-Z0-9_]+)$/);
    if (!m)
        return null;
    return { host: m[1], pane: unslugPaneId(m[2]) };
}
//# sourceMappingURL=naming.js.map