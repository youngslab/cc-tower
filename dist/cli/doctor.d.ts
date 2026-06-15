/**
 * popmux doctor — diagnose and optionally repair corrupted state.json entries.
 *
 * Detects:
 *  - orphaned_convid: lastConversationId set but no JSONL exists for it
 *  - cross_cwd_convid: lastConversationId != lastSessionId and convId JSONL lives in
 *    a different cwd than the sessionId JSONL (cross-pane contamination signal)
 *  - dangling_session_ref: lastSessionId references a sessions[] entry with no cwd
 *
 * With --apply: backs up state.json.YYYYMMDD.bak then removes only the offending
 * lastConversationId fields. NEVER deletes entries with favorite === true.
 */
interface Finding {
    identity: string;
    kind: 'orphaned_convid' | 'cross_cwd_convid' | 'dangling_session_ref';
    detail: string;
    favorite: boolean;
}
export interface DoctorOptions {
    apply?: boolean;
    dryRun?: boolean;
    statePath?: string;
    claudeDir?: string;
}
export interface DoctorReport {
    findings: Finding[];
    backupPath?: string;
    applied: boolean;
}
export declare function runDoctor(opts?: DoctorOptions): DoctorReport;
export declare function printDoctorReport(report: DoctorReport): void;
export {};
