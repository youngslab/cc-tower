export type CodexMvpStatus = 'running' | 'unknown';

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

export interface CodexMvpSession {
  agentId: 'codex';
  sessionId: string;
  pid: number;
  wrapperPid?: number | undefined;
  cwd: string;
  projectName: string;
  status: CodexMvpStatus;
  paneId?: string | undefined;
  tmuxSession?: string | undefined;
  windowIndex?: number | undefined;
  launchKind: 'fresh' | 'resume' | 'unknown';
  resumeThreadId?: string | undefined;
}

export interface ProcReader {
  readCwd(pid: number): string | null | Promise<string | null>;
}
