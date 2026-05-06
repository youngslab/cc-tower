/**
 * Mirror window manager — Plan v2 §B3.
 *
 * When the user picks a remote claude session in the popmux picker, we
 * dedicate a tmux *window* in a hidden session called `__popmux_mirrors`
 * that runs `ssh -t <host> 'tmux attach -t <pane>'`. The window is
 * persistent: the next `go` for the same (host, pane) reuses it instead
 * of spawning a fresh ssh tunnel. This is the nested-tmux pattern.
 *
 * Lifecycle:
 *   1. Caller invokes `goToMirror({ host, pane, sshTarget })`.
 *   2. We acquire a per-host lock (so concurrent calls don't race).
 *   3. We prune dead mirrors (ssh exited) and stale mirrors (TTL expired).
 *   4. We check whether the target window is alive; if not, we create it.
 *   5. We tag the window-status with `[shared mirror]` (Plan §C2).
 *   6. We `switch-client -t __popmux_mirrors:<window>` to bring the user in.
 *
 * Aliveness has three components:
 *   - tmux window with the expected name exists
 *   - first pane's `pane_dead` is 0
 *   - the pane's process tree has a live `ssh` (see ssh-presence.ts)
 */
import { execa } from 'execa';
import { isSshAlive } from './ssh-presence.js';
import { withHostLock } from './lock.js';
import { touchActivity, getActivityMtime, clearActivity } from './activity.js';
export const MIRROR_SESSION = '__popmux_mirrors';
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes (M4)
// ── Naming helpers ──────────────────────────────────────────────────────────
/**
 * Slug a paneId for use in a tmux window name. tmux window names cannot
 * contain '%' or '#' (they have format-string meaning). We replace `%` with
 * `pct` and disallow other non-word chars.
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
function slugHost(host) {
    return host.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
/** Compose the window name for (host, pane). */
export function windowName(host, pane) {
    return `mirror-${slugHost(host)}-${slugPaneId(pane)}`;
}
/**
 * Parse a window name back to (host, slug). Returns null if the name does
 * not follow the `mirror-<host>-<paneSlug>` pattern. Note: host names that
 * contain hyphens are recovered correctly by anchoring on the trailing
 * paneSlug pattern (`pct\d+` or word chars).
 */
export function parseWindowName(name) {
    if (!name.startsWith('mirror-'))
        return null;
    // Anchor on the trailing slug — paneSlug is either `pct<digits>` or a
    // word-only run. host is everything in between.
    const m = name.match(/^mirror-(.+?)-(pct\d+|[a-zA-Z0-9_]+)$/);
    if (!m)
        return null;
    return { host: m[1], pane: unslugPaneId(m[2]) };
}
// ── tmux primitives (small typed wrappers — no shell escaping) ─────────────
async function listMirrorWindowNames() {
    const r = await execa('tmux', [
        'list-windows', '-t', MIRROR_SESSION, '-F', '#W',
    ], { reject: false });
    if (r.exitCode !== 0)
        return [];
    return r.stdout.split('\n').filter((l) => l.startsWith('mirror-'));
}
async function listPaneInfoForWindow(win) {
    const r = await execa('tmux', [
        'list-panes', '-t', `${MIRROR_SESSION}:${win}`, '-F', '#{pane_dead}|#{pane_pid}',
    ], { reject: false });
    if (r.exitCode !== 0)
        return [];
    const out = [];
    for (const line of r.stdout.split('\n')) {
        if (!line)
            continue;
        const [deadStr, pidStr] = line.split('|');
        const pid = parseInt(pidStr, 10);
        if (Number.isNaN(pid))
            continue;
        out.push({ dead: deadStr === '1', pid });
    }
    return out;
}
// ── Public API ──────────────────────────────────────────────────────────────
/** Idempotently ensure the `__popmux_mirrors` tmux session exists. */
export async function ensureMirrorSession() {
    const has = await execa('tmux', ['has-session', '-t', MIRROR_SESSION], { reject: false });
    if (has.exitCode === 0)
        return;
    // Detached so we never accidentally yank focus to it.
    await execa('tmux', ['new-session', '-d', '-s', MIRROR_SESSION], { reject: false });
}
/**
 * Determine whether the mirror window for (host, pane) is currently alive.
 *
 * Three conditions, ALL must hold:
 *   1. tmux window with the correct name exists in `__popmux_mirrors`.
 *   2. The pane's `#{pane_dead}` is 0 (process tree still running).
 *   3. The pane has a live `ssh` somewhere in its immediate process tree.
 */
export async function isMirrorAlive(host, pane) {
    const win = windowName(host, pane);
    const winNames = await listMirrorWindowNames();
    if (!winNames.includes(win))
        return false;
    const panes = await listPaneInfoForWindow(win);
    if (panes.length === 0)
        return false;
    for (const p of panes) {
        if (p.dead)
            return false;
        if (!await isSshAlive(p.pid))
            return false;
    }
    return true;
}
/**
 * Kill any mirror windows whose ssh is no longer alive (or whose tmux pane
 * is dead). Returns the names of removed windows.
 */
export async function cleanupDeadMirrors() {
    const winNames = await listMirrorWindowNames();
    const killed = [];
    for (const win of winNames) {
        const parsed = parseWindowName(win);
        if (!parsed)
            continue;
        if (!await isMirrorAlive(parsed.host, parsed.pane)) {
            await execa('tmux', ['kill-window', '-t', `${MIRROR_SESSION}:${win}`], { reject: false });
            clearActivity(parsed.host, parsed.pane);
            killed.push(win);
        }
    }
    return killed;
}
/**
 * Kill any mirror windows whose last-activity is older than the TTL. The
 * window is removed even if ssh is still healthy — this is a deliberate
 * eviction policy to bound resource usage.
 */
export async function cleanupStaleMirrors(opts) {
    const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
    const winNames = await listMirrorWindowNames();
    const killed = [];
    const now = Date.now();
    for (const win of winNames) {
        const parsed = parseWindowName(win);
        if (!parsed)
            continue;
        const mtime = getActivityMtime(parsed.host, parsed.pane);
        // No marker — treat as never-touched and skip (defer eviction). Operator
        // can delete the window manually with `mirror --clean` if truly orphaned.
        if (mtime === null)
            continue;
        if (now - mtime > ttl) {
            await execa('tmux', ['kill-window', '-t', `${MIRROR_SESSION}:${win}`], { reject: false });
            clearActivity(parsed.host, parsed.pane);
            killed.push(win);
        }
    }
    return killed;
}
/**
 * Build the ssh command-string we hand to `tmux new-window`. Single quotes
 * are escaped using the standard `'\''` trick. Note: tmux passes the entire
 * string to `/bin/sh -c`, so shell-escaping rules apply.
 */
function buildSshCommand(target) {
    // We send: ssh -t <sshTarget> "tmux attach -t <pane> \; select-pane -t <pane>"
    // The remote command is wrapped in double-quotes so the literal `\;` becomes
    // a tmux command separator (after one shell unwrap). Single-quote any
    // user-controlled fields to neutralize injection.
    const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const remoteCmd = `tmux attach -t ${sq(target.pane)} \\; select-pane -t ${sq(target.pane)}`;
    return `ssh -t ${sq(target.sshTarget)} "${remoteCmd}"`;
}
/**
 * Switch the current client to the mirror window for (host, pane). Creates
 * the window if it does not already exist or is dead. Updates last-activity.
 */
export async function goToMirror(target, opts) {
    // 1. Update activity BEFORE acquiring the lock so user-perceived freshness
    //    is recorded even if the lock takes a moment.
    touchActivity(target.host, target.pane);
    await withHostLock(target.host, async () => {
        // 2. Best-effort eviction of dead/stale mirrors before we (maybe) create one.
        await cleanupDeadMirrors();
        await cleanupStaleMirrors({ ttlMs: opts?.ttlMs });
        // 3. Make sure the holder session exists.
        await ensureMirrorSession();
        const win = windowName(target.host, target.pane);
        const alive = await isMirrorAlive(target.host, target.pane);
        if (!alive) {
            // 4a. Create the mirror window. Detached so we don't auto-switch yet.
            const sshCmd = buildSshCommand(target);
            await execa('tmux', [
                'new-window',
                '-d',
                '-t', `${MIRROR_SESSION}:`,
                '-n', win,
                sshCmd,
            ], { reject: false });
        }
        // 5. Mark the window as a shared mirror in the status line (C2).
        //    Setting per-window option so it only affects this window when active.
        await execa('tmux', [
            'set-window-option', '-t', `${MIRROR_SESSION}:${win}`,
            'window-status-current-format',
            '[shared mirror — input may interleave] #I:#W',
        ], { reject: false });
        // 6. switch-client → user lands inside the mirror window.
        await execa('tmux', ['switch-client', '-t', `${MIRROR_SESSION}:${win}`], { reject: false });
    });
}
/**
 * Return all current mirror windows with their aliveness + age. Useful for
 * `popmux mirror --list` and integration tests.
 */
export async function listMirrors() {
    const winNames = await listMirrorWindowNames();
    const out = [];
    const now = Date.now();
    for (const win of winNames) {
        const parsed = parseWindowName(win);
        if (!parsed)
            continue;
        const alive = await isMirrorAlive(parsed.host, parsed.pane);
        const mtime = getActivityMtime(parsed.host, parsed.pane);
        out.push({
            window: win,
            host: parsed.host,
            pane: parsed.pane,
            alive,
            ageMs: mtime !== null ? now - mtime : null,
        });
    }
    return out;
}
//# sourceMappingURL=window-manager.js.map