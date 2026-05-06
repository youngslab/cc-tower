/**
 * Extract the user-supplied label from a Claude Code JSONL session.
 *
 * Currently the only label source is the `/rename` command, which Claude
 * Code persists as a `custom-title` JSONL line. This module is a thin
 * façade so callers do not have to reach into status-inferer for label work.
 */
export declare function extractLabel(jsonlPath: string): string | undefined;
