import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { fuzzyMatch } from './fuzzy.js';
import { agentLabel, agentShortBadge, normalizeAgentId, type AgentId } from '../agents/types.js';

export interface HostOption {
  name: string;
  ssh: string;
  commandPrefix?: string;
}

export interface PastSessionByCwd {
  agentId?: AgentId;
  sessionId: string;
  resumeId?: string;
  resumable?: boolean;
  cwd: string;
  startedAt: number;
  label?: string;
  labelSource?: string;
  goalSummary?: string;
  contextSummary?: string;
  sshTarget?: string;
}

interface Props {
  hosts: HostOption[];
  onSelect: (projectPath: string, host?: HostOption, resumeSessionId?: string, agentId?: AgentId) => void;
  onCancel: () => void;
  getPastSessionsByTarget: (sshTarget?: string) => PastSessionByCwd[];
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

function isPathLike(q: string): boolean {
  return /^[/~.]/.test(q);
}

function expand(q: string): string {
  return q.startsWith('~') ? q.replace('~', process.env['HOME'] ?? '') : q;
}

export function NewSession({ onSelect, onCancel, getPastSessionsByTarget }: Props) {
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('claude');

  const workspaces = useMemo(
    () => getPastSessionsByTarget(undefined),
    [getPastSessionsByTarget],
  );

  const filtered = useMemo(() => {
    if (!query) return workspaces;
    return workspaces.filter(s => fuzzyMatch(query, s.cwd) || fuzzyMatch(query, path.basename(s.cwd)));
  }, [workspaces, query]);

  const showStartIn = isPathLike(query) && query.trim() !== '';

  const completions = useMemo(() => {
    if (!showStartIn) return [];
    return listCompletions(query);
  }, [showStartIn, query]);

  const rowCount = filtered.length + (showStartIn ? 1 : 0);

  const handlePathSelected = useCallback((projectPath: string) => {
    onSelect(projectPath, undefined, undefined, selectedAgent);
  }, [onSelect, selectedAgent]);

  useInput((input, key) => {
    if (key.escape) {
      if (query) { setQuery(''); setCursor(0); return; }
      onCancel();
      return;
    }

    if (input === 'a') {
      setSelectedAgent(a => a === 'claude' ? 'codex' : 'claude');
      return;
    }
    if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(rowCount - 1, c + 1)); return; }
    if (key.tab) {
      if (showStartIn) {
        setQuery(tabComplete(query));
      }
      return;
    }
    if (key.return) {
      if (showStartIn && cursor === 0) {
        handlePathSelected(expand(query).replace(/\/$/, ''));
      } else {
        const idx = showStartIn ? cursor - 1 : cursor;
        if (filtered[idx]) handlePathSelected(filtered[idx]!.cwd);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return) {
      setQuery(q => q + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">New AI Session</Text>
      <>
          <Box>
            <Text dimColor>Path or filter: </Text>
            <Text color="cyan">{query || ''}</Text>
            {query ? <Text color="gray">▋</Text> : <Text dimColor> (type to filter or enter a path)</Text>}
          </Box>
          <Text dimColor>Agent: {agentLabel(selectedAgent)} · press a to toggle</Text>
          <Text> </Text>
          {showStartIn && (
            <Box>
              <Text color={cursor === 0 ? 'cyan' : undefined} bold={cursor === 0}>
                {cursor === 0 ? '▸ ' : '  '}Start in: {expand(query)}
              </Text>
              <Text dimColor>   (Tab complete)</Text>
            </Box>
          )}
          {completions.length > 1 && (
            <Box flexDirection="column">
              {completions.map(c => (
                <Text key={c} dimColor>  {c}/</Text>
              ))}
            </Box>
          )}
          {filtered.map((s, i) => (
            <Box key={s.cwd}>
              <Text color={cursor === (showStartIn ? i + 1 : i) ? 'cyan' : undefined} bold={cursor === (showStartIn ? i + 1 : i)}>
                {cursor === (showStartIn ? i + 1 : i) ? '▸ ' : '  '}[{agentShortBadge(normalizeAgentId(s.agentId))}] {path.basename(s.cwd)}
              </Text>
              <Text dimColor> {s.cwd}  ·  {formatAge(s.startedAt)}</Text>
            </Box>
          ))}
          {filtered.length === 0 && !showStartIn && query && (
            <Text dimColor>  No matches for "{query}"</Text>
          )}
          <Text> </Text>
          <Text dimColor>↑↓ navigate · a toggle agent · type = filter or path (/,~,.) · Tab complete · Enter select · Esc cancel</Text>
      </>
    </Box>
  );
}
