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
    return <Text color="green">Installing hook plugin...</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="yellow">
      <Text bold color="yellow">popmux hook plugin is not installed.</Text>
      <Text></Text>
      <Text>Works without hooks (JSONL fallback),</Text>
      <Text>but hooks provide real-time state tracking.</Text>
      <Text></Text>
      <Text>[y] Install now  [n] Later</Text>
    </Box>
  );
}
