import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Session } from '../core/session-store.js';

interface Props {
  session: Session;
  onBack: () => void;
  onSend: (session: Session) => void;
  onPeek: (session: Session) => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  executing: { icon: '●', color: 'green' },
  thinking: { icon: '◐', color: 'yellow' },
  agent: { icon: '◑', color: 'cyan' },
  idle: { icon: '○', color: 'white' },
  dead: { icon: '✕', color: 'red' },
};

export function DetailView({ session, onBack, onSend, onPeek }: Props) {
  useInput((input, key) => {
    if (input === 'b' || key.escape) onBack();
    if (input === '/') onSend(session);
    if (input === 'p') onPeek(session);
  });

  const elapsed = formatDuration(Date.now() - session.startedAt.getTime());
  const { icon, color } = STATUS_ICONS[session.status] ?? { icon: '○', color: 'gray' };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Session: {session.label ?? session.projectName}</Text>
        <Text> ({session.paneId ?? 'no pane'})</Text>
        {session.favorite && <Text color="yellow">  ★ Favorite</Text>}
      </Box>

      <Box flexDirection="column" paddingX={2}>
        <Text>Project:  {session.cwd}</Text>
        <Text>Host:     {session.host}{session.sshTarget ? ` (${session.sshTarget})` : ''}</Text>
        <Text>PID:      {session.pid}  │  Pane: {session.paneId ?? '—'}  │  Mode: {session.detectionMode}</Text>
        <Text>Status:   <Text color={color}>{icon} {session.status.toUpperCase()}</Text></Text>
        <Text>Started:  {elapsed} ago</Text>
        <Text>Messages: {session.messageCount}  │  Tools: {session.toolCallCount}  │  Cost: ~${(session.estimatedCost ?? 0).toFixed(2)}</Text>
      </Box>

      {session.goalSummary && (
        <Box marginTop={1} paddingX={2} flexDirection="column">
          <Text bold dimColor>── Goal ──</Text>
          <Text color="cyan">{session.goalSummary}</Text>
        </Box>
      )}

      {session.contextSummary && (
        <Box marginTop={1} paddingX={2} flexDirection="column">
          <Text bold dimColor>── Now ──</Text>
          <Text color="green">{session.contextSummary}</Text>
        </Box>
      )}

      {session.currentTask && (
        <Box marginTop={1} paddingX={2} flexDirection="column">
          <Text bold dimColor>── Last Request ──</Text>
          <Text>{session.currentTask}</Text>
        </Box>
      )}

      {session.currentActivity && (
        <Box marginTop={1} paddingX={2} flexDirection="column">
          <Text bold dimColor>── Current Activity ──</Text>
          <Text dimColor>{session.currentActivity}</Text>
        </Box>
      )}

      {session.nextSteps && (
        <Box marginTop={1} paddingX={2} flexDirection="column">
          <Text bold dimColor>── Action Item ──</Text>
          <Text color="yellow">{session.nextSteps}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[/] Send  [p] Peek  [b] Back</Text>
      </Box>
    </Box>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
