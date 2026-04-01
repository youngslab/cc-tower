import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface HostOption {
  name: string;
  ssh: string;
  commandPrefix?: string;
}

export interface PastSession {
  sessionId: string;
  startedAt: number;
  goalSummary?: string;
  contextSummary?: string;
  nextSteps?: string;
}

export interface PastSessionByCwd {
  sessionId: string;
  cwd: string;
  startedAt: number;
  goalSummary?: string;
  contextSummary?: string;
  sshTarget?: string;
}

interface Props {
  projects: Array<{ name: string; path: string; lastUsed: Date }>;
  hosts: HostOption[];
  onSelect: (projectPath: string, host?: HostOption, resumeSessionId?: string) => void;
  onCancel: () => void;
  getPastSessions: (cwd: string) => PastSession[];
  getPastSessionsByTarget: (sshTarget?: string) => PastSessionByCwd[];
  getAllPastSessions: () => PastSessionByCwd[];
  onDeleteSession: (sessionId: string) => void;
}

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function remoteListDirs(host: HostOption, dir: string): string[] {
  try {
    const cmd = `ls -1 -d ${dir}/*/ 2>/dev/null | xargs -I{} basename {}`;
    const fullCmd = host.commandPrefix
      ? `${host.commandPrefix} sh -c '${cmd.replace(/'/g, "'\\''")}'`
      : cmd;
    const out = execFileSync('ssh', [host.ssh, fullCmd], { timeout: 5000 }).toString();
    return out.trim().split('\n').filter(Boolean).filter(n => !n.startsWith('.'));
  } catch {}
  return [];
}

function tabCompleteRemote(input: string, host: HostOption): string {
  if (!input) return input;
  const dir = input.endsWith('/') ? input.replace(/\/$/, '') : path.posix.dirname(input);
  const prefix = input.endsWith('/') ? '' : path.posix.basename(input);
  const entries = remoteListDirs(host, dir).filter(n => n.toLowerCase().startsWith(prefix.toLowerCase())).sort();

  if (entries.length === 1) {
    return `${dir}/${entries[0]!}/`;
  } else if (entries.length > 1) {
    let common = entries[0]!;
    for (const e of entries) {
      let i = 0;
      while (i < common.length && i < e.length && common[i]!.toLowerCase() === e[i]!.toLowerCase()) i++;
      common = common.slice(0, i);
    }
    if (common.length > prefix.length) return `${dir}/${common}`;
  }
  return input;
}

function listCompletionsRemote(input: string, host: HostOption): string[] {
  if (!input) return [];
  const dir = input.endsWith('/') ? input.replace(/\/$/, '') : path.posix.dirname(input);
  const prefix = input.endsWith('/') ? '' : path.posix.basename(input);
  return remoteListDirs(host, dir)
    .filter(n => n.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort()
    .slice(0, 8);
}

function tabComplete(input: string): string {
  if (!input) return input;
  const expanded = input.startsWith('~') ? input.replace('~', process.env['HOME'] ?? '') : input;
  const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
  const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort();

    if (entries.length === 1) {
      return path.join(dir, entries[0]!.name) + '/';
    } else if (entries.length > 1) {
      // Find common prefix
      let common = entries[0]!.name;
      for (const e of entries) {
        let i = 0;
        while (i < common.length && i < e.name.length && common[i]!.toLowerCase() === e.name[i]!.toLowerCase()) i++;
        common = common.slice(0, i);
      }
      if (common.length > prefix.length) {
        return path.join(dir, common);
      }
    }
  } catch {}
  return input;
}

function listCompletions(input: string): string[] {
  if (!input) return [];
  const expanded = input.startsWith('~') ? input.replace('~', process.env['HOME'] ?? '') : input;
  const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
  const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);

  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(e => e.name)
      .sort()
      .slice(0, 8);
  } catch {}
  return [];
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return 'recently';
}

export function NewSession({ projects, hosts, onSelect, onCancel, getPastSessions, getPastSessionsByTarget, getAllPastSessions, onDeleteSession }: Props) {
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'host' | 'list' | 'host-list' | 'custom' | 'resume' | 'recent'>(() => {
    const hasRecent = getAllPastSessions().length > 0;
    if (hasRecent) return 'recent';
    return hosts.length > 0 ? 'host' : 'list';
  });
  const [selectedHost, setSelectedHost] = useState<HostOption | undefined>(undefined);
  const [pendingPath, setPendingPath] = useState('');
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [listCursor, setListCursor] = useState(-1); // -1 = text input focused, 0+ = past session list
  const [customOrigin, setCustomOrigin] = useState<'list' | 'recent'>('list');

  // Host options: "local" + configured remote hosts
  const hostOptions: Array<{ label: string; host?: HostOption }> = [
    { label: 'local' },
    ...hosts.map(h => ({ label: `⌁ ${h.name} (${h.ssh})`, host: h })),
  ];

  const filtered = useMemo(() => {
    if (!filter) return projects;
    return projects.filter(p => fuzzyMatch(filter, p.name) || fuzzyMatch(filter, p.path));
  }, [projects, filter]);

  const completions = useMemo(() => {
    if (mode !== 'custom') return [];
    return selectedHost ? listCompletionsRemote(customPath, selectedHost) : listCompletions(customPath);
  }, [mode, customPath, selectedHost]);

  const targetSessions = useMemo(() => {
    if (mode !== 'custom' && mode !== 'host-list') return [];
    return getPastSessionsByTarget(selectedHost?.ssh).filter(s => !deletedIds.has(s.sessionId));
  }, [mode, selectedHost, getPastSessionsByTarget, deletedIds]);

  const recentSessions = useMemo(() =>
    getAllPastSessions().filter(s => !deletedIds.has(s.sessionId)),
    [getAllPastSessions, deletedIds]
  );

  const handlePathSelected = useCallback((projectPath: string) => {
    const past = getPastSessions(projectPath);
    if (past.length > 0) {
      setPendingPath(projectPath);
      setPastSessions(past);
      setMode('resume');
      setCursor(0);
    } else {
      onSelect(projectPath, selectedHost);
    }
  }, [getPastSessions, onSelect, selectedHost]);

  useInput((input, key) => {
    if (key.escape) {
      if (mode === 'resume') { setMode(selectedHost ? 'custom' : 'list'); setCursor(0); return; }
      if (mode === 'custom') { setMode(selectedHost ? 'host-list' : customOrigin); setCustomPath(''); setCursor(0); return; }
      if (mode === 'host-list') { setMode('host'); setCursor(0); return; }
      if (mode === 'list' && filter) { setFilter(''); setCursor(0); return; }
      if ((mode === 'list' || mode === 'host') && recentSessions.length > 0) { setMode('recent'); setCursor(0); return; }
      onCancel();
      return;
    }

    if (mode === 'recent') {
      if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor(c => Math.min(recentSessions.length - 1, c + 1));
      if (key.return && recentSessions[cursor]) {
        const s = recentSessions[cursor]!;
        const host = s.sshTarget ? hosts.find(h => h.ssh === s.sshTarget) : undefined;
        onSelect(s.cwd, host, s.sessionId);
      }
      if (input === 'n') {
        setMode(hosts.length > 0 ? 'host' : 'list');
        setCursor(0);
      }
      if (input === 'c') {
        setSelectedHost(undefined);
        setCustomPath('');
        setCustomOrigin('recent');
        setMode('custom');
        setCursor(0);
        setListCursor(-1);
      }
      if (input === 'd' && recentSessions[cursor]) {
        const id = recentSessions[cursor]!.sessionId;
        onDeleteSession(id);
        setDeletedIds(prev => new Set([...prev, id]));
        setCursor(c => Math.min(c, Math.max(0, recentSessions.length - 2)));
      }
      return;
    }

    if (mode === 'host') {
      if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor(c => Math.min(hostOptions.length - 1, c + 1));
      if (key.return) {
        const chosen = hostOptions[cursor];
        setSelectedHost(chosen?.host);
        setMode(chosen?.host ? 'host-list' : 'list');
        setCursor(0);
        setListCursor(-1);
      }
      return;
    }

    if (mode === 'resume') {
      const total = pastSessions.length + 1;
      if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor(c => Math.min(total - 1, c + 1));
      if (key.return) {
        if (cursor < pastSessions.length) {
          onSelect(pendingPath, selectedHost, pastSessions[cursor]!.sessionId);
        } else {
          onSelect(pendingPath, selectedHost);
        }
      }
      return;
    }

    if (mode === 'host-list') {
      if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor(c => Math.min(targetSessions.length, c + 1));
      if (key.return) {
        if (cursor === targetSessions.length) {
          setMode('custom');
          setCursor(0);
        } else if (targetSessions[cursor]) {
          handlePathSelected(targetSessions[cursor]!.cwd);
        }
      }
      if (input === 'd' && targetSessions[cursor]) {
        const id = targetSessions[cursor]!.sessionId;
        onDeleteSession(id);
        setDeletedIds(prev => new Set([...prev, id]));
        setCursor(c => Math.min(c, Math.max(0, targetSessions.length - 2)));
      }
      return;
    }

    if (mode === 'list') {
      if (key.upArrow || (input === 'k' && !filter)) setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || (input === 'j' && !filter)) setCursor(c => Math.min(filtered.length, c + 1));
      if (key.return) {
        if (cursor === filtered.length) {
          setCustomOrigin('list');
          setMode('custom');
        } else if (filtered[cursor]) {
          handlePathSelected(filtered[cursor]!.path);
        }
      }
      if (key.backspace || key.delete) {
        setFilter(f => f.slice(0, -1));
        setCursor(0);
      } else if (input && !key.ctrl && !key.meta && !key.return && !(input === 'j' && !filter) && !(input === 'k' && !filter)) {
        setFilter(f => f + input);
        setCursor(0);
      }
    } else {
      // custom mode
      if (key.upArrow) {
        setListCursor(c => Math.max(-1, c - 1));
        return;
      }
      if (key.downArrow) {
        setListCursor(c => Math.min(targetSessions.length - 1, c + 1));
        return;
      }
      if (key.tab) {
        setCustomPath(selectedHost ? tabCompleteRemote(customPath, selectedHost) : tabComplete(customPath));
        setListCursor(-1);
        return;
      }
      if (key.return) {
        if (listCursor >= 0 && targetSessions[listCursor]) {
          handlePathSelected(targetSessions[listCursor]!.cwd);
        } else if (customPath.trim()) {
          const expanded = customPath.startsWith('~') ? customPath.replace('~', process.env['HOME'] ?? '') : customPath;
          handlePathSelected(expanded.replace(/\/$/, ''));
        }
        return;
      }
      if (input === 'd' && listCursor >= 0 && targetSessions[listCursor]) {
        const id = targetSessions[listCursor]!.sessionId;
        onDeleteSession(id);
        setDeletedIds(prev => new Set([...prev, id]));
        setListCursor(c => Math.min(c, targetSessions.length - 2));
        return;
      }
      if (key.backspace || key.delete) {
        setCustomPath(p => p.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        setCustomPath(p => p + input);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">New Claude Session</Text>

      {mode === 'recent' ? (
        <>
          <Text bold color="cyan">Recent Sessions</Text>
          <Text> </Text>
          {recentSessions.length === 0 ? (
            <Text dimColor>  No past sessions</Text>
          ) : (
            recentSessions.map((s, i) => {
              const sel = i === cursor;
              const label = s.cwd.split('/').pop() ?? s.cwd;
              const summary = s.contextSummary ?? s.goalSummary;
              const hostBadge = s.sshTarget ? `⌁ ${s.sshTarget.split('@').pop() ?? s.sshTarget}` : 'local';
              return (
                <Box key={s.sessionId} flexDirection="column">
                  <Box>
                    <Text color={sel ? 'cyan' : undefined} bold={sel}>{sel ? '▸ ' : '  '}</Text>
                    <Text color={sel ? 'cyan' : undefined} bold={sel}>{label}</Text>
                    <Text dimColor>  [{hostBadge}]  {s.cwd}  ·  {formatAge(s.startedAt)}</Text>
                  </Box>
                  {summary && sel && (
                    <Text dimColor>    {summary.length > 72 ? summary.slice(0, 71) + '…' : summary}</Text>
                  )}
                </Box>
              );
            })
          )}
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Enter resume · n new · c custom path · d delete · Esc cancel</Text>
        </>
      ) : mode === 'host' ? (
        <>
          <Text dimColor>Select target host</Text>
          <Text> </Text>
          {hostOptions.map((h, i) => (
            <Box key={h.label}>
              <Text color={i === cursor ? 'cyan' : undefined} bold={i === cursor}>
                {i === cursor ? '▸ ' : '  '}{h.label}
              </Text>
            </Box>
          ))}
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
        </>
      ) : mode === 'host-list' ? (
        <>
          <Text dimColor>⌁ {selectedHost?.name} ({selectedHost?.ssh})</Text>
          <Text> </Text>
          {targetSessions.length === 0 ? (
            <Text dimColor>  No past sessions</Text>
          ) : (
            targetSessions.map((s, i) => {
              const sel = i === cursor;
              const label = s.cwd.split('/').pop() ?? s.cwd;
              const summary = s.contextSummary ?? s.goalSummary;
              return (
                <Box key={s.sessionId} flexDirection="column">
                  <Box>
                    <Text color={sel ? 'cyan' : undefined} bold={sel}>{sel ? '▸ ' : '  '}</Text>
                    <Text color={sel ? 'cyan' : undefined} bold={sel}>{label}</Text>
                    <Text dimColor>  {s.cwd}  ·  {formatAge(s.startedAt)}</Text>
                  </Box>
                  {summary && sel && (
                    <Text dimColor>    {summary.length > 72 ? summary.slice(0, 71) + '…' : summary}</Text>
                  )}
                </Box>
              );
            })
          )}
          <Box>
            <Text color={cursor === targetSessions.length ? 'cyan' : undefined} bold={cursor === targetSessions.length}>
              {cursor === targetSessions.length ? '▸ ' : '  '}Enter custom path...
            </Text>
          </Box>
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Enter select · d delete · Esc back</Text>
        </>
      ) : mode === 'list' ? (
        <>
          <Box>
            <Text dimColor>Filter: </Text>
            <Text color="cyan">{filter || ''}</Text>
            {filter ? <Text color="gray">▋</Text> : <Text dimColor> (type to filter)</Text>}
          </Box>
          <Text> </Text>
          {filtered.map((p, i) => (
            <Box key={p.path}>
              <Text color={i === cursor ? 'cyan' : undefined} bold={i === cursor}>
                {i === cursor ? '▸ ' : '  '}{p.name}
              </Text>
              <Text dimColor> {p.path}</Text>
            </Box>
          ))}
          <Box>
            <Text color={cursor === filtered.length ? 'cyan' : undefined} bold={cursor === filtered.length}>
              {cursor === filtered.length ? '▸ ' : '  '}Enter custom path...
            </Text>
          </Box>
          {filtered.length === 0 && projects.length > 0 && (
            <Text dimColor>  No matches for "{filter}"</Text>
          )}
          <Text> </Text>
          <Text dimColor>↑↓ navigate · type to filter · Enter select · Esc cancel</Text>
        </>
      ) : mode === 'resume' ? (
        <>
          <Text bold color="cyan">Resume a past session?</Text>
          <Text dimColor>{pendingPath}</Text>
          <Text> </Text>
          {pastSessions.map((s, i) => {
            const summary = s.contextSummary ?? s.goalSummary ?? s.nextSteps;
            const age = formatAge(s.startedAt);
            const isSelected = i === cursor;
            return (
              <Box key={s.sessionId} flexDirection="column">
                <Box>
                  <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                    {isSelected ? '▸ ' : '  '}
                  </Text>
                  <Text color={isSelected ? 'cyan' : 'white'}>Resume</Text>
                  <Text dimColor> · {age}</Text>
                </Box>
                {summary && (
                  <Text dimColor>    {summary.length > 80 ? summary.slice(0, 79) + '…' : summary}</Text>
                )}
              </Box>
            );
          })}
          <Box>
            <Text color={cursor === pastSessions.length ? 'cyan' : undefined} bold={cursor === pastSessions.length}>
              {cursor === pastSessions.length ? '▸ ' : '  '}Start fresh
            </Text>
          </Box>
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Enter select · Esc back</Text>
        </>
      ) : (
        <>
          <Box>
            <Text dimColor={listCursor >= 0}>Path: </Text>
            <Text color="cyan">{customPath}</Text>
            {listCursor < 0 && <Text color="gray">▋</Text>}
          </Box>
          {completions.length > 1 && listCursor < 0 && (
            <Box flexDirection="column">
              {completions.map(c => (
                <Text key={c} dimColor>  {c}/</Text>
              ))}
            </Box>
          )}
          {targetSessions.length > 0 && (
            <>
              <Text> </Text>
              <Text dimColor>─── Recent ───────────────────────────</Text>
              {targetSessions.map((s, i) => {
                const sel = i === listCursor;
                const label = s.cwd.split('/').pop() ?? s.cwd;
                const summary = s.contextSummary ?? s.goalSummary;
                return (
                  <Box key={s.sessionId} flexDirection="column">
                    <Box>
                      <Text color={sel ? 'cyan' : undefined} bold={sel}>{sel ? '▸ ' : '  '}</Text>
                      <Text color={sel ? 'cyan' : undefined} bold={sel}>{label}</Text>
                      <Text dimColor>  {s.cwd}  ·  {formatAge(s.startedAt)}</Text>
                    </Box>
                    {summary && sel && (
                      <Text dimColor>    {summary.length > 72 ? summary.slice(0, 71) + '…' : summary}</Text>
                    )}
                  </Box>
                );
              })}
            </>
          )}
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Tab complete · Enter confirm · d delete · Esc back</Text>
        </>
      )}
    </Box>
  );
}
