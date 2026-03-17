export interface MappingResult {
    paneId: string | undefined;
    hasTmux: boolean;
}
/**
 * Map a Claude PID to a tmux pane via ppid chain walking.
 * Returns { paneId: undefined, hasTmux: false } if tmux is not available.
 * Returns { paneId: undefined, hasTmux: true } if no matching pane found.
 */
export declare function mapPidToPane(claudePid: number): Promise<MappingResult>;
