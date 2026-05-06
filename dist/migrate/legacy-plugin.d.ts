export interface DisableResult {
    /** Path that was inspected (whether or not we acted). */
    pluginJsonPath: string;
    /** Path of the resulting `.disabled` marker, if any. */
    disabledPath: string;
    /** True iff we actually performed a rename in this call. */
    disabled: boolean;
    /** True iff a `.disabled` marker already exists (regardless of whether we acted). */
    alreadyDisabled: boolean;
}
/**
 * Disable the legacy cc-tower Claude plugin if present. Returns metadata
 * describing the action taken. Stderr message is written when a rename
 * actually happens, matching the behavior described in plan v2 §3.4.
 */
export declare function disableLegacyCcTowerPlugin(homeDir?: string): DisableResult;
