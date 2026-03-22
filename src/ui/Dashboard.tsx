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
  onToggleFavorite: (session: Session) => void;
  onNewSession: () => void;
  onRefresh: (session: Session) => void;
  onQuit: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  executing: { icon: '●', color: 'green' },
  thinking: { icon: '◐', color: 'yellow' },
  agent: { icon: '◑', color: 'cyan' },
  idle: { icon: '○', color: 'white' },
  dead: { icon: '✕', color: 'red' },
};

export function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onToggleFavorite, onNewSession, onRefresh, onQuit }: Props) {
  const [cursor, setCursor] = useState(0);
  const [confirmQuit, setConfirmQuit] = useState(false);

  // Sort: favorites (stable order) → tmux sessions (by status) → non-tmux sessions (by status)
  const favorites = sessions.filter(s => s.favorite).sort((a, b) => (a.favoritedAt ?? 0) - (b.favoritedAt ?? 0));
  const nonFavorites = sessions.filter(s => !s.favorite);
  const sorted = [...favorites, ...nonFavorites];

  useInput((input, key) => {
    // Quit confirmation mode
    if (confirmQuit) {
      if (input === 'y') onQuit();
      if (input === 'n' || key.escape) setConfirmQuit(false);
      return;
    }

    // Navigation: arrow keys + j/k (vim style)
    if (key.upArrow || input === 'k') setCursor(c => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor(c => Math.min(sorted.length - 1, c + 1));

    // Number keys: jump to session (1-9)
    if (input >= '1' && input <= '9') {
      const idx = parseInt(input) - 1;
      if (idx < sorted.length) setCursor(idx);
    }

    // Actions
    if (key.return && sorted[cursor]) onSelect(sorted[cursor]!);
    if (input === '/' && sorted[cursor]) onSend(sorted[cursor]!);
    if (input === 'p' && sorted[cursor]) onPeek(sorted[cursor]!);
    if (input === 'f' && sorted[cursor]) onToggleFavorite(sorted[cursor]!);
    if (input === 'r' && sorted[cursor]) onRefresh(sorted[cursor]!);

    // Quit with confirmation
    if (input === 'n') onNewSession();

    if (input === 'q' || (key.ctrl && input === 'c')) setConfirmQuit(true);
  });

  const hasFavorites = favorites.length > 0;
  const hasNonFavorites = nonFavorites.length > 0;
  const nonTmuxStart = nonFavorites.findIndex(s => !s.hasTmux);
  // Index in sorted array where non-tmux non-favorites start
  const nonTmuxSortedStart = nonTmuxStart >= 0 ? favorites.length + nonTmuxStart : -1;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold dimColor>{centerPad('', 4)}</Text>
        <Text bold dimColor>{centerPad('LABEL', 22)}</Text>
        <Text bold dimColor>{centerPad('', 3)}</Text>
        <Text bold dimColor>{centerPad('GOAL', maxTaskWidth)}</Text>
      </Box>

      {/* Session rows */}
      {sorted.map((session, i) => {
        const isCursor = i === cursor;
        const isDim = !session.hasTmux || session.status === 'dead';
        const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle']!;

        // Separator before non-tmux non-favorite sessions
        const showNonTmuxSep = i === nonTmuxSortedStart && nonTmuxSortedStart > 0;
        // Separator between favorites and non-favorites
        const showFavSep = hasFavorites && hasNonFavorites && i === favorites.length;

        const labelText = (session.favorite ? '★ ' : '') + (session.sshTarget ? '⌁ ' : '') + session.projectName;

        return (
          <React.Fragment key={session.sessionId}>
            {showFavSep && (
              <Text dimColor>{'─'.repeat(60)} favorites ↑</Text>
            )}
            {showNonTmuxSep && (
              <Text dimColor>{'· · · ·'.repeat(5)} (monitor-only)</Text>
            )}
            <Box>
              <Text inverse={isCursor} color={isCursor ? 'cyan' : undefined} bold={isCursor}>{isCursor ? '▸' : ' '}</Text>
              <Text inverse={isCursor} color={isCursor ? 'cyan' : undefined} dimColor={!isCursor}>{pad(`${i + 1}`, 3)}</Text>
              <Text inverse={isCursor} color={isCursor ? 'cyan' : undefined} dimColor={!isCursor && isDim}>{pad(labelText, 22)}</Text>
              <Text inverse={isCursor} color={isCursor ? 'cyan' : (isDim ? 'gray' : color)}>{pad(icon, 3)}</Text>
              {session.label && <Text inverse={isCursor} color={isCursor ? 'cyan' : 'blue'} bold>[{session.label}] </Text>}<Text inverse={isCursor} color={isCursor ? 'cyan' : undefined} dimColor={!isCursor && isDim}>{truncate(session.goalSummary ?? session.contextSummary ?? session.currentTask ?? (session.summaryLoading ? '⟳ summarizing...' : ''), maxTaskWidth - (session.label ? session.label.length + 3 : 0))}</Text>
            </Box>
            {session.status === 'idle' && session.nextSteps && (
              <Box>
                <Text>{' '}</Text>
                <Text>{pad('', 3)}</Text>
                <Text>{pad('', 22)}</Text>
                <Text>{pad('', 3)}</Text>
                <Text color="yellow">↳ {truncate(session.nextSteps, maxTaskWidth)}</Text>
              </Box>
            )}
            <Box height={1} />
          </React.Fragment>
        );
      })}

      {sorted.length === 0 && (
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
          <Text dimColor>[j/k] Nav  [1-9] Jump  │  [Enter] Detail  [p] Peek  [/] Send  │  [f] Fav  [n] New  [r] Refresh  [q] Quit</Text>
        </Box>
      )}
    </Box>
  );
}

import stringWidth from 'string-width';

function centerPad(str: string, len: number): string {
  const w = stringWidth(str);
  if (w >= len) return str;
  const left = Math.floor((len - w) / 2);
  const right = len - w - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function pad(str: string, len: number): string {
  const truncated = truncate(str, len);
  const w = stringWidth(truncated);
  return w < len ? truncated + ' '.repeat(len - w) : truncated;
}

function truncate(str: string, max: number): string {
  if (stringWidth(str) <= max) return str;
  let result = '';
  let w = 0;
  for (const ch of str) {
    const cw = stringWidth(ch);
    if (w + cw > max - 1) break;
    result += ch;
    w += cw;
  }
  return result + '…';
}
