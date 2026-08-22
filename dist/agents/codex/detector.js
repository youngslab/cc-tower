import path from 'node:path';
import { readlinkSync } from 'node:fs';
import { execa } from 'execa';
import { readCodexThreads, resolveCodexThreadMetadata } from './metadata.js';
const INTERACTIVE_SUBCOMMANDS = new Set(['resume', 'fork']);
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
    'exec',
    'review',
    'mcp',
    'completion',
    'help',
]);
function basename(value) {
    return path.basename(value).toLowerCase();
}
function shellishTokens(args) {
    return Array.from(args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (match) => match[1] ?? match[2] ?? match[3] ?? '');
}
function normalizeTty(tty) {
    if (!tty || tty === '?')
        return undefined;
    if (tty.startsWith('/dev/'))
        return tty;
    if (tty.startsWith('pts/'))
        return `/dev/${tty}`;
    return tty;
}
export function parsePsOutput(stdout) {
    return stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
        if (!match)
            return null;
        const pid = Number.parseInt(match[1], 10);
        const ppid = Number.parseInt(match[2], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid))
            return null;
        return {
            pid,
            ppid,
            tty: normalizeTty(match[3]),
            command: match[4],
            args: match[5] ?? '',
        };
    })
        .filter((row) => row !== null);
}
export function parseTmuxPanes(stdout) {
    return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
        const [paneId, tty, pidText, currentCommand, currentPath, windowIndexText, sessionName] = line.split('\t');
        if (!paneId || !tty || !pidText)
            return null;
        const pid = Number.parseInt(pidText, 10);
        const windowIndex = windowIndexText === undefined || windowIndexText === '' ? undefined : Number.parseInt(windowIndexText, 10);
        if (!Number.isFinite(pid))
            return null;
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
        .filter((pane) => pane !== null);
}
function tokensAfterExecutable(row) {
    const tokens = shellishTokens(row.args);
    if (tokens.length === 0)
        return [];
    return tokens.slice(1);
}
export function isNativeCodex(row) {
    return basename(row.command) === 'codex';
}
export function isCodexNodeWrapper(row) {
    if (basename(row.command) !== 'node')
        return false;
    const tokens = shellishTokens(row.args);
    return tokens.some((token, index) => index > 0 && basename(token) === 'codex');
}
export function isInteractiveCodex(row) {
    const rest = tokensAfterExecutable(row);
    if (rest.some((token) => token === '--help' || token === '-h' || token === '--version' || token === '-V')) {
        return false;
    }
    const firstNonOption = rest.find((token) => !token.startsWith('-'));
    if (firstNonOption === undefined)
        return true;
    if (INTERACTIVE_SUBCOMMANDS.has(firstNonOption))
        return true;
    if (NON_INTERACTIVE_SUBCOMMANDS.has(firstNonOption))
        return false;
    return true;
}
function extractResumeArg(row) {
    const rest = tokensAfterExecutable(row);
    const resumeIndex = rest.indexOf('resume');
    if (resumeIndex === -1)
        return undefined;
    return rest.slice(resumeIndex + 1).find((token) => !token.startsWith('-'));
}
function findAncestor(row, byPid, predicate) {
    let current = row.ppid;
    const seen = new Set();
    while (current > 1 && !seen.has(current)) {
        seen.add(current);
        const candidate = byPid.get(current);
        if (!candidate)
            return undefined;
        if (predicate(candidate))
            return candidate;
        current = candidate.ppid;
    }
    return undefined;
}
export function mapProcessToPane(row, byPid, panes) {
    const panesByPid = new Map(panes.map((pane) => [pane.pid, pane]));
    let current = row;
    const seen = new Set();
    while (current && current.pid > 1 && !seen.has(current.pid)) {
        seen.add(current.pid);
        const pidMatch = panesByPid.get(current.pid);
        if (pidMatch)
            return pidMatch;
        const tty = normalizeTty(current.tty);
        if (tty) {
            const ttyMatch = panes.find((pane) => pane.tty === tty);
            if (ttyMatch)
                return ttyMatch;
        }
        current = byPid.get(current.ppid);
    }
    return undefined;
}
function projectNameFromCwd(cwd) {
    const base = path.basename(cwd);
    return base === '' ? cwd : base;
}
export async function discoverCodexSessions(opts) {
    const panes = opts.panes ?? [];
    const byPid = new Map(opts.processes.map((row) => [row.pid, row]));
    const threads = readCodexThreads();
    const claimedThreadIds = new Set();
    const sessions = [];
    for (const row of opts.processes) {
        if (!isNativeCodex(row) || !isInteractiveCodex(row))
            continue;
        const wrapper = findAncestor(row, byPid, isCodexNodeWrapper);
        const cwd = (await opts.procReader.readCwd(row.pid))
            ?? (wrapper ? await opts.procReader.readCwd(wrapper.pid) : null)
            ?? '';
        if (!cwd)
            continue;
        const resumeArg = extractResumeArg(row);
        const pane = mapProcessToPane(row, byPid, panes);
        const metadata = resolveCodexThreadMetadata({ cwd, resumeArg, threads, claimedThreadIds });
        if (metadata.threadId)
            claimedThreadIds.add(metadata.threadId);
        const stableSessionId = metadata.threadId ?? (resumeArg && metadata.confidence === 'high' ? resumeArg : undefined);
        sessions.push({
            agentId: 'codex',
            sessionId: stableSessionId ?? `codex-proc-${row.pid}`,
            pid: row.pid,
            cwd,
            startedAt: Date.now(),
            paneId: pane?.paneId,
            projectName: projectNameFromCwd(cwd),
            launchKind: resumeArg ? 'resume' : 'fresh',
            resumeId: stableSessionId,
            resumable: Boolean(stableSessionId && metadata.resumable),
            label: metadata.label,
            labelSource: metadata.labelSource,
            metadataConfidence: metadata.confidence,
        });
    }
    return sessions.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.pid - b.pid);
}
export async function readLiveProcesses() {
    const result = await execa('ps', ['-eo', 'pid=,ppid=,tty=,comm=,args=']);
    return parsePsOutput(result.stdout);
}
export async function readLiveTmuxPanes() {
    const result = await execa('tmux', [
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{window_index}\t#{session_name}',
    ], { reject: false });
    if (result.exitCode !== 0)
        return [];
    return parseTmuxPanes(result.stdout);
}
export const liveProcReader = {
    readCwd(pid) {
        try {
            return readlinkSync(`/proc/${pid}/cwd`);
        }
        catch {
            return null;
        }
    },
};
export async function discoverLiveCodexSessions() {
    const [processes, panes] = await Promise.all([readLiveProcesses(), readLiveTmuxPanes()]);
    return discoverCodexSessions({ processes, panes, procReader: liveProcReader });
}
//# sourceMappingURL=detector.js.map