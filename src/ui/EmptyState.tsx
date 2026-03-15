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
          <Text color="yellow">⚠ tmux 환경이 아닙니다. Peek/Zoom이 동작하지 않습니다.</Text>
        </Box>
      )}

      <Text>활성 Claude Code 세션이 없습니다.</Text>
      <Text dimColor>다른 터미널에서 claude 실행 시 자동 탐지됩니다.</Text>

      {!hookInstalled && (
        <Box marginTop={1}>
          <Text color="yellow">⚠ Hook 플러그인 미설치 — cc-tower install-hooks 로 설치하면 실시간 추적</Text>
        </Box>
      )}
    </Box>
  );
}
