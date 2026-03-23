import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';

interface Props {
  projects: Array<{ name: string; path: string; lastUsed: Date }>;
  onSelect: (projectPath: string) => void;
  onCancel: () => void;
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

export function NewSession({ projects, onSelect, onCancel }: Props) {
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [mode, setMode] = useState<'list' | 'custom'>('list');

  const filtered = useMemo(() => {
    if (!filter) return projects;
    return projects.filter(p => fuzzyMatch(filter, p.name) || fuzzyMatch(filter, p.path));
  }, [projects, filter]);

  const completions = useMemo(() => {
    if (mode !== 'custom') return [];
    return listCompletions(customPath);
  }, [mode, customPath]);

  useInput((input, key) => {
    if (key.escape) {
      if (mode === 'custom') { setMode('list'); setCustomPath(''); return; }
      if (filter) { setFilter(''); setCursor(0); return; }
      onCancel();
      return;
    }

    if (mode === 'list') {
      if (key.upArrow || (input === 'k' && !filter)) setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || (input === 'j' && !filter)) setCursor(c => Math.min(filtered.length, c + 1));
      if (key.return) {
        if (cursor === filtered.length) {
          setMode('custom');
        } else if (filtered[cursor]) {
          onSelect(filtered[cursor]!.path);
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
      if (key.tab) {
        setCustomPath(tabComplete(customPath));
        return;
      }
      if (key.return && customPath.trim()) {
        const expanded = customPath.startsWith('~') ? customPath.replace('~', process.env['HOME'] ?? '') : customPath;
        onSelect(expanded.replace(/\/$/, ''));
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

      {mode === 'list' ? (
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
      ) : (
        <>
          <Box>
            <Text>Path: </Text>
            <Text color="cyan">{customPath}</Text>
            <Text color="gray">▋</Text>
          </Box>
          {completions.length > 1 && (
            <Box marginTop={1} flexDirection="column">
              {completions.map(c => (
                <Text key={c} dimColor>  {c}/</Text>
              ))}
            </Box>
          )}
          <Text> </Text>
          <Text dimColor>Tab complete · Enter confirm · Esc back</Text>
        </>
      )}
    </Box>
  );
}
