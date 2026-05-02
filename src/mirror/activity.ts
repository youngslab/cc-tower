/**
 * Per-mirror last-activity tracking (Plan v2 §N4 — TTL eviction).
 *
 * Each (host, paneId) pair gets a tiny marker file in `$XDG_RUNTIME_DIR/popmux/`
 * whose mtime represents the last time the user `go`'d to that mirror. The
 * window-manager periodically prunes mirrors whose mtime is older than the
 * configured TTL so abandoned ssh tunnels don't pile up indefinitely.
 *
 * We track via mtime (not file contents) so the file stays empty/zero-byte
 * and `touchActivity` is a single syscall hot path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ACTIVITY_DIR = path.join(process.env['XDG_RUNTIME_DIR'] || '/tmp', 'popmux');

function slugPaneId(pane: string): string {
  // tmux pane ids look like "%5". '%' is filesystem-legal but inconvenient
  // — we replace it with "pct" to keep filenames easy to glob/inspect.
  return pane.replace(/^%/, 'pct').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function slugHost(host: string): string {
  return host.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function activityPath(host: string, pane: string): string {
  return path.join(ACTIVITY_DIR, `mirror.${slugHost(host)}.${slugPaneId(pane)}.activity`);
}

/** Stamp now() as the last-activity time for (host, pane). Idempotent. */
export function touchActivity(host: string, pane: string): void {
  fs.mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  const p = activityPath(host, pane);
  // Create-or-truncate then utimes to "now". writeFileSync('') is ~free.
  fs.writeFileSync(p, '');
  const now = new Date();
  fs.utimesSync(p, now, now);
}

/** Returns mtime in ms-since-epoch, or null if the marker does not exist. */
export function getActivityMtime(host: string, pane: string): number | null {
  try {
    return fs.statSync(activityPath(host, pane)).mtimeMs;
  } catch {
    return null;
  }
}

/** Best-effort cleanup — remove the marker for this (host, pane). */
export function clearActivity(host: string, pane: string): void {
  try { fs.unlinkSync(activityPath(host, pane)); } catch {}
}
