import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  projects: Array<{ name: string; path: string; lastUsed: Date }>;
  onSelect: (projectPath: string) => void;
  onCancel: () => void;
}

export function NewSession({ projects, onSelect, onCancel }: Props) {
  const [cursor, setCursor] = useState(0);
  const [customPath, setCustomPath] = useState('');
  const [mode, setMode] = useState<'list' | 'custom'>('list');

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }

    if (mode === 'list') {
      if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor(c => Math.min(projects.length, c + 1));
      if (key.return) {
        if (cursor === projects.length) {
          setMode('custom');
        } else if (projects[cursor]) {
          onSelect(projects[cursor]!.path);
        }
      }
    } else {
      if (key.return && customPath.trim()) {
        onSelect(customPath.trim());
      }
      if (key.backspace || key.delete) {
        setCustomPath(p => p.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setCustomPath(p => p + input);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">New Claude Session</Text>
      <Text dimColor>Select a recent project or enter a custom path</Text>
      <Text> </Text>
      {mode === 'list' ? (
        <>
          {projects.map((p, i) => (
            <Box key={p.path}>
              <Text color={i === cursor ? 'cyan' : undefined} bold={i === cursor}>
                {i === cursor ? '▸ ' : '  '}{p.name}
              </Text>
              <Text dimColor> {p.path}</Text>
            </Box>
          ))}
          <Box>
            <Text color={cursor === projects.length ? 'cyan' : undefined} bold={cursor === projects.length}>
              {cursor === projects.length ? '▸ ' : '  '}Enter custom path...
            </Text>
          </Box>
          <Text> </Text>
          <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
        </>
      ) : (
        <>
          <Box>
            <Text>Path: </Text>
            <Text color="cyan">{customPath}</Text>
            <Text color="gray">▋</Text>
          </Box>
          <Text> </Text>
          <Text dimColor>Enter confirm · Esc cancel</Text>
        </>
      )}
    </Box>
  );
}
