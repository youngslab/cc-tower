import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Session } from '../core/session-store.js';

interface Props {
  session: Session;
  confirmWhenBusy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function SendInput({ session, confirmWhenBusy, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const isBusy = session.status === 'thinking' || session.status === 'executing' || session.status === 'agent';

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      if (!text.trim()) return;
      if (isBusy && confirmWhenBusy && !confirming) {
        setConfirming(true);
        return;
      }
      onSend(text);
      return;
    }
    if (key.backspace || key.delete) {
      setText(t => t.slice(0, -1));
      return;
    }
    if (confirming) {
      if (input === 'y') { onSend(text); return; }
      if (input === 'n') { setConfirming(false); return; }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText(t => t + input);
    }
  });

  if (!session.hasTmux) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">This session is not connected to tmux.</Text>
      </Box>
    );
  }

  if (confirming) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color="yellow">Session is busy. Send anyway? [y/n]</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text>Send to {session.label ?? session.projectName}: </Text>
      <Text color="green">{text}</Text>
      <Text dimColor>█</Text>
    </Box>
  );
}
