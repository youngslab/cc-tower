export declare function activityPath(host: string, pane: string): string;
/** Stamp now() as the last-activity time for (host, pane). Idempotent. */
export declare function touchActivity(host: string, pane: string): void;
/** Returns mtime in ms-since-epoch, or null if the marker does not exist. */
export declare function getActivityMtime(host: string, pane: string): number | null;
/** Best-effort cleanup — remove the marker for this (host, pane). */
export declare function clearActivity(host: string, pane: string): void;
