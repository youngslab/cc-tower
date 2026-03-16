import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Session } from '../core/session-store.js';
import { EmptyState } from './EmptyState.js';

interface Props {
  sessions: Session[];
  tmuxCount: number;
  maxTaskWidth: number;
  onSelect: (session: Session) => void;
  onSend: (session: Session) => void;
  onPeek: (session: Session) => void;
  onZoom: (session: Session) => void;
  onQuit: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  executing: { icon: '●', color: 'green' },
  thinking: { icon: '◐', color: 'yellow' },
  agent: { icon: '◑', color: 'cyan' },
  idle: { icon: '○', color: 'gray' },
  dead: { icon: '✕', color: 'red' },
};

export function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onZoom, onQuit }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(sessions.length - 1, c + 1));
    if (key.return && sessions[cursor]) onSelect(sessions[cursor]!);
    if (input === '/' && sessions[cursor]) onSend(sessions[cursor]!);
    if (input === 'p' && sessions[cursor]) onPeek(sessions[cursor]!);
    if (input === 'z' && sessions[cursor]) onZoom(sessions[cursor]!);
    if (input === 'q') onQuit();
  });

  const nonTmuxStart = sessions.findIndex(s => !s.hasTmux);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">cc-tower</Text>
        <Text> — {sessions.length} sessions</Text>
      </Box>

      {/* Header */}
      <Box>
        <Text bold>  </Text>
        <Text bold dimColor>{pad('PANE', 7)}</Text>
        <Text bold dimColor>{pad('LABEL', 18)}</Text>
        <Text bold dimColor>{pad('STATUS', 14)}</Text>
        <Text bold dimColor>TASK</Text>
      </Box>

      {/* Session rows */}
      {sessions.map((session, i) => {
        const isCursor = i === cursor;
        const isDim = !session.hasTmux || session.status === 'dead';
        const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle']!;

        // Separator before non-tmux sessions
        const showSep = i === nonTmuxStart && nonTmuxStart > 0;

        return (
          <React.Fragment key={session.sessionId}>
            {showSep && (
              <Text dimColor>{'─'.repeat(60)} (monitor-only)</Text>
            )}
            <Box>
              <Text>{isCursor ? '▸ ' : '  '}</Text>
              <Text dimColor={isDim}>{pad(session.paneId ?? '—', 7)}</Text>
              <Text dimColor={isDim}>{pad(session.label ?? session.projectName, 18)}</Text>
              <Text color={isDim ? 'gray' : color}>{pad(`${icon} ${session.status.toUpperCase()}`, 14)}</Text>
              <Text dimColor={isDim}>{truncate(session.contextSummary ?? session.currentTask ?? '', maxTaskWidth)}</Text>
            </Box>
          </React.Fragment>
        );
      })}

      {sessions.length === 0 && (
        <EmptyState inTmux={tmuxCount > 0} hookInstalled={true} />
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>[Enter] Detail  [z] Zoom  [p] Peek  [/] Send  [q] Quit</Text>
      </Box>
    </Box>
  );
}

function pad(str: string, len: number): string {
  return str.slice(0, len).padEnd(len);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}
