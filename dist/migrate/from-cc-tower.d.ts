export interface MigrateResult {
    migrated: {
        state: boolean;
        config: boolean;
        agentIdFilled: number;
    };
    skipped: {
        reason?: string;
    };
    warnings: string[];
    markerPath: string;
}
export declare function detectLegacy(): {
    hasSrcDir: boolean;
    hasMarker: boolean;
    hasPlugin: boolean;
};
export declare function migrateFromCcTower(opts?: {
    force?: boolean;
    dryRun?: boolean;
}): MigrateResult;
