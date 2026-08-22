export interface ProcessRow {
    pid: number;
    ppid: number;
    tty?: string | undefined;
    command: string;
    args: string;
}
export interface PaneSnapshot {
    paneId: string;
    tty: string;
    pid: number;
    currentCommand?: string | undefined;
    currentPath?: string | undefined;
    windowIndex?: number | undefined;
    sessionName?: string | undefined;
}
export interface ProcReader {
    readCwd(pid: number): string | null | Promise<string | null>;
}
export interface CodexThreadRow {
    id: string;
    cwd?: string | undefined;
    title?: string | undefined;
    name?: string | undefined;
    updatedAt?: number | undefined;
    createdAt?: number | undefined;
}
export interface CodexSessionInfo {
    agentId: 'codex';
    pid: number;
    sessionId: string;
    cwd: string;
    projectName: string;
    startedAt: number;
    paneId?: string | undefined;
    resumeId?: string | undefined;
    resumable: boolean;
    label?: string | undefined;
    labelSource?: 'codex-title' | 'codex-name-diagnostic' | 'popmux' | undefined;
    metadataConfidence?: 'low' | 'medium' | 'high' | undefined;
    launchKind: 'fresh' | 'resume' | 'unknown';
}
