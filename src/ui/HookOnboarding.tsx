import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  onInstall: () => Promise<void>;
  onSkip: () => void;
}

export function HookOnboarding({ onInstall, onSkip }: Props) {
  const [installing, setInstalling] = useState(false);

  useInput(async (input) => {
    if (input === 'y' && !installing) {
      setInstalling(true);
      await onInstall();
    }
    if (input === 'n') onSkip();
  });

  if (installing) {
    return <Text color="green">Hook 플러그인 설치 중...</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="yellow">
      <Text bold color="yellow">cc-tower hook 플러그인이 설치되지 않았습니다.</Text>
      <Text></Text>
      <Text>Hook 없이도 동작하지만 (JSONL fallback),</Text>
      <Text>Hook을 설치하면 실시간 상태 감지 + 풍부한 정보를 받습니다.</Text>
      <Text></Text>
      <Text>[y] 지금 설치  [n] 나중에</Text>
    </Box>
  );
}
