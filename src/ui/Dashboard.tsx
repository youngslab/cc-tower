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
  onQuit: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  executing: { icon: '●', color: 'green' },
  thinking: { icon: '◐', color: 'yellow' },
  agent: { icon: '◑', color: 'cyan' },
  idle: { icon: '○', color: 'white' },
  dead: { icon: '✕', color: 'red' },
};

export function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onQuit }: Props) {
  const [cursor, setCursor] = useState(0);
  const [confirmQuit, setConfirmQuit] = useState(false);

  useInput((input, key) => {
    // Quit confirmation mode
    if (confirmQuit) {
      if (input === 'y') onQuit();
      if (input === 'n' || key.escape) setConfirmQuit(false);
      return;
    }

    // Navigation: arrow keys + j/k (vim style)
    if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor(c => Math.min(sessions.length - 1, c + 1));

    // Number keys: jump to session (1-9)
    if (input >= '1' && input <= '9') {
      const idx = parseInt(input) - 1;
      if (idx < sessions.length) setCursor(idx);
    }

    // Actions
    if (key.return && sessions[cursor]) onSelect(sessions[cursor]!);
    if (input === '/' && sessions[cursor]) onSend(sessions[cursor]!);
    if (input === 'p' && sessions[cursor]) onPeek(sessions[cursor]!);

    // Quit with confirmation
    if (input === 'q' || (key.ctrl && input === 'c')) setConfirmQuit(true);
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
        <Text bold>   </Text>
        <Text bold dimColor>{pad('PANE', 7)}</Text>
        <Text bold dimColor>{pad('HOST', 9)}</Text>
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
              <Text>{isCursor ? '▸' : ' '}</Text>
              <Text dimColor>{`${i + 1} `}</Text>
              <Text dimColor={isDim}>{pad(session.paneId ?? '—', 7)}</Text>
              <Text dimColor={isDim}>{pad(session.host, 9)}</Text>
              <Text dimColor={isDim}>{pad(session.label ?? session.projectName, 18)}</Text>
              <Text color={isDim ? 'gray' : color}>{pad(`${icon} ${session.status.toUpperCase()}`, 14)}</Text>
              <Text dimColor={isDim}>{truncate(session.contextSummary ?? session.currentActivity ?? session.currentTask ?? (session.summaryLoading ? '⟳ summarizing...' : ''), maxTaskWidth)}</Text>
            </Box>
          </React.Fragment>
        );
      })}

      {sessions.length === 0 && (
        <EmptyState inTmux={tmuxCount > 0} hookInstalled={true} />
      )}

      {/* Quit confirmation popup */}
      {confirmQuit && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={0} justifyContent="center">
          <Text color="yellow">Quit cc-tower?  </Text>
          <Text bold color="green">[y] Yes  </Text>
          <Text bold color="red">[n] No</Text>
        </Box>
      )}

      {/* Footer */}
      {!confirmQuit && (
        <Box marginTop={1}>
          <Text dimColor>[j/k] Navigate  [1-9] Jump  [Enter] Detail  [p] Peek  [/] Send  [q] Quit</Text>
        </Box>
      )}
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
