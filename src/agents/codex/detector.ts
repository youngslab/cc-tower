import path from 'node:path';
import { readFileSync, readlinkSync } from 'node:fs';
import { execa } from 'execa';
import { readCodexThreads, resolveCodexThreadMetadata } from './metadata.js';
import type { CodexSessionInfo, CodexThreadRow, PaneSnapshot, ProcReader, ProcessRow } from './types.js';

const INTERACTIVE_SUBCOMMANDS = new Set(['resume', 'fork']);
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'exec',
  'review',
  'mcp',
  'completion',
  'help',
]);

function basename(value: string): string {
  return path.basename(value).toLowerCase();
}

function shellishTokens(args: string): string[] {
  return Array.from(args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function normalizeTty(tty: string | undefined): string | undefined {
  if (!tty || tty === '?') return undefined;
  if (tty.startsWith('/dev/')) return tty;
  if (tty.startsWith('pts/')) return `/dev/${tty}`;
  return tty;
}

export function parsePsOutput(stdout: string): ProcessRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): ProcessRow | null => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1]!, 10);
      const ppid = Number.parseInt(match[2]!, 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
      return {
        pid,
        ppid,
        tty: normalizeTty(match[3]),
        command: match[4]!,
        args: match[5] ?? '',
      };
    })
    .filter((row): row is ProcessRow => row !== null);
}

export function parseTmuxPanes(stdout: string): PaneSnapshot[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): PaneSnapshot | null => {
      const [paneId, tty, pidText, currentCommand, currentPath, windowIndexText, sessionName] = line.split('\t');
      if (!paneId || !tty || !pidText) return null;
      const pid = Number.parseInt(pidText, 10);
      const windowIndex = windowIndexText === undefined || windowIndexText === '' ? undefined : Number.parseInt(windowIndexText, 10);
      if (!Number.isFinite(pid)) return null;
      return {
        paneId,
        tty,
        pid,
        currentCommand,
        currentPath,
        windowIndex: Number.isFinite(windowIndex) ? windowIndex : undefined,
        sessionName,
      };
    })
    .filter((pane): pane is PaneSnapshot => pane !== null);
}

function tokensAfterExecutable(row: ProcessRow): string[] {
  const tokens = shellishTokens(row.args);
  if (tokens.length === 0) return [];
  return tokens.slice(1);
}

export function isNativeCodex(row: ProcessRow): boolean {
  return basename(row.command) === 'codex';
}

export function isCodexNodeWrapper(row: ProcessRow): boolean {
  if (basename(row.command) !== 'node') return false;
  const tokens = shellishTokens(row.args);
  return tokens.some((token, index) => index > 0 && basename(token) === 'codex');
}

export function isInteractiveCodex(row: ProcessRow): boolean {
  const rest = tokensAfterExecutable(row);
  if (rest.some((token) => token === '--help' || token === '-h' || token === '--version' || token === '-V')) {
    return false;
  }
  const firstNonOption = rest.find((token) => !token.startsWith('-'));
  if (firstNonOption === undefined) return true;
  if (INTERACTIVE_SUBCOMMANDS.has(firstNonOption)) return true;
  if (NON_INTERACTIVE_SUBCOMMANDS.has(firstNonOption)) return false;
  return true;
}

const RESUME_OPTION_VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-C',
  '--cd',
  '--cwd',
  '-m',
  '--model',
  '--model-provider',
  '--profile',
  '--sandbox',
  '--approval-policy',
  '--ask-for-approval',
]);

function findResumeSubcommandIndex(row: ProcessRow): number {
  const rest = tokensAfterExecutable(row);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--') return -1;
    if (token.startsWith('-')) {
      if (optionConsumesValue(token)) index += 1;
      continue;
    }
    return token === 'resume' ? index : -1;
  }
  return -1;
}

function hasResumeSubcommand(row: ProcessRow): boolean {
  return findResumeSubcommandIndex(row) !== -1;
}

function optionConsumesValue(token: string): boolean {
  if (token.includes('=')) return false;
  return RESUME_OPTION_VALUE_FLAGS.has(token);
}

function extractResumeArg(row: ProcessRow): string | undefined {
  const rest = tokensAfterExecutable(row);
  const resumeIndex = findResumeSubcommandIndex(row);
  if (resumeIndex === -1) return undefined;

  for (let index = resumeIndex + 1; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--') return rest[index + 1];
    if (token.startsWith('-')) {
      if (optionConsumesValue(token)) index += 1;
      continue;
    }
    return token;
  }

  return undefined;
}

function parseOmxSessionStartedAt(sessionId: string | undefined | null): number | undefined {
  const match = sessionId?.match(/^omx-(\d{13})-/);
  if (!match) return undefined;
  const startedAtMs = Number(match[1]);
  if (!Number.isFinite(startedAtMs)) return undefined;
  return startedAtMs / 1000;
}

async function readOmxSessionStartedAt(row: ProcessRow, wrapper: ProcessRow | undefined, procReader: ProcReader): Promise<number | undefined> {
  if (!procReader.readEnv) return undefined;
  const fromRow = await procReader.readEnv(row.pid, 'OMX_SESSION_ID');
  const fromWrapper = fromRow ? undefined : wrapper ? await procReader.readEnv(wrapper.pid, 'OMX_SESSION_ID') : undefined;
  return parseOmxSessionStartedAt(fromRow ?? fromWrapper);
}

function findAncestor(
  row: ProcessRow,
  byPid: Map<number, ProcessRow>,
  predicate: (candidate: ProcessRow) => boolean,
): ProcessRow | undefined {
  let current = row.ppid;
  const seen = new Set<number>();
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    const candidate = byPid.get(current);
    if (!candidate) return undefined;
    if (predicate(candidate)) return candidate;
    current = candidate.ppid;
  }
  return undefined;
}

export function mapProcessToPane(
  row: ProcessRow,
  byPid: Map<number, ProcessRow>,
  panes: PaneSnapshot[],
): PaneSnapshot | undefined {
  const panesByPid = new Map(panes.map((pane) => [pane.pid, pane]));
  let current: ProcessRow | undefined = row;
  const seen = new Set<number>();
  while (current && current.pid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid);
    const pidMatch = panesByPid.get(current.pid);
    if (pidMatch) return pidMatch;

    const tty = normalizeTty(current.tty);
    if (tty) {
      const ttyMatch = panes.find((pane) => pane.tty === tty);
      if (ttyMatch) return ttyMatch;
    }

    current = byPid.get(current.ppid);
  }
  return undefined;
}

function projectNameFromCwd(cwd: string): string {
  const base = path.basename(cwd);
  return base === '' ? cwd : base;
}

export async function discoverCodexSessions(opts: {
  processes: ProcessRow[];
  panes?: PaneSnapshot[];
  procReader: ProcReader;
  threads?: CodexThreadRow[];
}): Promise<CodexSessionInfo[]> {
  const panes = opts.panes ?? [];
  const byPid = new Map(opts.processes.map((row) => [row.pid, row]));
  const threads = opts.threads ?? readCodexThreads();
  const claimedThreadIds = new Set<string>();
  const sessions: CodexSessionInfo[] = [];

  for (const row of opts.processes) {
    if (!isNativeCodex(row) || !isInteractiveCodex(row)) continue;

    const wrapper = findAncestor(row, byPid, isCodexNodeWrapper);
    const cwd = (await opts.procReader.readCwd(row.pid))
      ?? (wrapper ? await opts.procReader.readCwd(wrapper.pid) : null)
      ?? '';
    if (!cwd) continue;

    const resumeArg = extractResumeArg(row);
    const resumeWithoutArg = hasResumeSubcommand(row) && !resumeArg;
    const sessionStartedAt = await readOmxSessionStartedAt(row, wrapper, opts.procReader);
    const pane = mapProcessToPane(row, byPid, panes);
    const metadata = resolveCodexThreadMetadata({ cwd, resumeArg, resumeWithoutArg, sessionStartedAt, threads, claimedThreadIds });
    if (metadata.threadId) claimedThreadIds.add(metadata.threadId);
    const stableSessionId = metadata.threadId ?? (resumeArg && metadata.confidence === 'high' ? resumeArg : undefined);
    const authoritativeLabel = metadata.confidence === 'high' && metadata.labelSource === 'codex-rename' ? metadata.label : undefined;
    const authoritativeLabelSource = authoritativeLabel ? metadata.labelSource : undefined;
    sessions.push({
      agentId: 'codex',
      sessionId: stableSessionId ?? `codex-proc-${row.pid}`,
      pid: row.pid,
      cwd,
      startedAt: Date.now(),
      paneId: pane?.paneId,
      projectName: projectNameFromCwd(cwd),
      launchKind: resumeArg || resumeWithoutArg ? 'resume' : 'fresh',
      resumeId: stableSessionId,
      resumable: Boolean(stableSessionId && metadata.resumable),
      label: authoritativeLabel,
      labelSource: authoritativeLabelSource,
      metadataConfidence: metadata.confidence,
    });
  }

  return sessions.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.pid - b.pid);
}

export async function readLiveProcesses(): Promise<ProcessRow[]> {
  const result = await execa('ps', ['-eo', 'pid=,ppid=,tty=,comm=,args=']);
  return parsePsOutput(result.stdout);
}

export async function readLiveTmuxPanes(): Promise<PaneSnapshot[]> {
  const result = await execa('tmux', [
    'list-panes',
    '-a',
    '-F',
    '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{window_index}\t#{session_name}',
  ], { reject: false });
  if (result.exitCode !== 0) return [];
  return parseTmuxPanes(result.stdout);
}

export const liveProcReader: ProcReader = {
  readCwd(pid: number): string | null {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  readEnv(pid: number, name: string): string | null {
    try {
      const prefix = `${name}=`;
      const value = readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((entry) => entry.startsWith(prefix));
      return value ? value.slice(prefix.length) : null;
    } catch {
      return null;
    }
  },
};

export async function discoverLiveCodexSessions(): Promise<CodexSessionInfo[]> {
  const [processes, panes] = await Promise.all([readLiveProcesses(), readLiveTmuxPanes()]);
  return discoverCodexSessions({ processes, panes, procReader: liveProcReader });
}
