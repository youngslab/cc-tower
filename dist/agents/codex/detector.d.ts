import type { CodexSessionInfo, CodexThreadRow, PaneSnapshot, ProcReader, ProcessRow } from './types.js';
export declare function parsePsOutput(stdout: string): ProcessRow[];
export declare function parseTmuxPanes(stdout: string): PaneSnapshot[];
export declare function isNativeCodex(row: ProcessRow): boolean;
export declare function isCodexNodeWrapper(row: ProcessRow): boolean;
export declare function isInteractiveCodex(row: ProcessRow): boolean;
export declare function mapProcessToPane(row: ProcessRow, byPid: Map<number, ProcessRow>, panes: PaneSnapshot[]): PaneSnapshot | undefined;
export declare function discoverCodexSessions(opts: {
    processes: ProcessRow[];
    panes?: PaneSnapshot[];
    procReader: ProcReader;
    threads?: CodexThreadRow[];
}): Promise<CodexSessionInfo[]>;
export declare function readLiveProcesses(): Promise<ProcessRow[]>;
export declare function readLiveTmuxPanes(): Promise<PaneSnapshot[]>;
export declare const liveProcReader: ProcReader;
export declare function discoverLiveCodexSessions(): Promise<CodexSessionInfo[]>;
