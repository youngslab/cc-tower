import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  inTmux: boolean;
  hookInstalled: boolean;
}

export function EmptyState({ inTmux, hookInstalled }: Props) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {!inTmux && (
        <Box marginBottom={1}>
          <Text color="yellow">⚠ Not in tmux. Send/Go will not work.</Text>
        </Box>
      )}

      <Text>No active AI coding sessions.</Text>
      <Text dimColor>Sessions will be auto-detected when Claude or local Codex is running.</Text>

      {!hookInstalled && (
        <Box marginTop={1}>
          <Text color="yellow">⚠ Hook plugin not installed — run popmux install-hooks for real-time tracking</Text>
        </Box>
      )}
    </Box>
  );
}
