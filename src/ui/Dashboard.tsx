import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Session } from '../core/session-store.js';
import { EmptyState } from './EmptyState.js';

interface Props {
  sessions: Session[];
  tmuxCount: number;
  maxTaskWidth: number;
  cursorSessionId: string | null;
  onCursorChange: (sessionId: string | null) => void;
  onSelect: (session: Session) => void;
  onSend: (session: Session) => void;
  onPeek: (session: Session) => void;
  onToggleFavorite: (session: Session) => void;
  onNewSession: () => void;
  onRefresh: (session: Session) => void;
  onKill: (session: Session) => void;
  onGo: (session: Session) => void;
  onQuit: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  executing: { icon: '●', color: 'green' },
  thinking: { icon: '◐', color: 'yellow' },
  agent: { icon: '◑', color: 'cyan' },
  idle: { icon: '○', color: 'white' },
  dead: { icon: '✕', color: 'red' },
};

export function Dashboard({ sessions, tmuxCount, maxTaskWidth, cursorSessionId, onCursorChange, onSelect, onSend, onPeek, onToggleFavorite, onNewSession, onRefresh, onKill, onGo, onQuit }: Props) {
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);

  // Stable order ref for non-favorites — order doesn't change on status updates
  const nonFavOrderRef = useRef<string[]>([]);

  // Favorites: sorted by favoritedAt (stable, time-based)
  const favorites = sessions.filter(s => s.favorite).sort((a, b) => (a.favoritedAt ?? 0) - (b.favoritedAt ?? 0));
  const nonFavorites = sessions.filter(s => !s.favorite);

  // Update stable non-favorite order: keep existing positions, remove gone, append new
  const currentNonFavIds = new Set(nonFavorites.map(s => s.sessionId));
  const existingInOrder = new Set(nonFavOrderRef.current);
  const stableNonFavIds = nonFavOrderRef.current.filter(id => currentNonFavIds.has(id));
  for (const s of nonFavorites) {
    if (!existingInOrder.has(s.sessionId)) stableNonFavIds.push(s.sessionId);
  }
  nonFavOrderRef.current = stableNonFavIds;

  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  const stableNonFavorites = stableNonFavIds.map(id => sessionMap.get(id)!).filter(Boolean);
  const sorted = [...favorites, ...stableNonFavorites];

  // Resolve cursor index from tracked sessionId (go to 0 if session is gone)
  const cursor = (() => {
    if (!cursorSessionId) return 0;
    const idx = sorted.findIndex(s => s.sessionId === cursorSessionId);
    return idx >= 0 ? idx : 0;
  })();

  const moveCursor = (newIdx: number) => {
    const session = sorted[newIdx];
    onCursorChange(session?.sessionId ?? null);
  };

  // Group boundary: index where non-favorites start
  const favGroupEnd = favorites.length;

  useInput((input, key) => {
    // Kill confirmation mode
    if (confirmKill) {
      if (input === 'y' && sorted[cursor]) { onKill(sorted[cursor]!); setConfirmKill(false); }
      if (input === 'n' || key.escape) setConfirmKill(false);
      return;
    }

    // Quit confirmation mode
    if (confirmQuit) {
      if (input === 'y') onQuit();
      if (input === 'n' || key.escape) setConfirmQuit(false);
      return;
    }

    // Navigation: arrow keys + j/k (vim style)
    if (key.upArrow || input === 'k') moveCursor(Math.max(0, cursor - 1));
    if (key.downArrow || input === 'j') moveCursor(Math.min(sorted.length - 1, cursor + 1));

    // Group jump: [ = jump to prev group start, ] = jump to next group start
    if (input === ']') {
      if (favGroupEnd > 0 && cursor < favGroupEnd) {
        // In favorites → jump to non-favorites start
        moveCursor(Math.min(favGroupEnd, sorted.length - 1));
      } else {
        // Already in non-favorites or no favorites → wrap to top
        moveCursor(0);
      }
    }
    if (input === '[') {
      if (favGroupEnd > 0 && cursor >= favGroupEnd) {
        // In non-favorites → jump to favorites start
        moveCursor(0);
      } else {
        // Already at favorites start → wrap to non-favorites start
        moveCursor(Math.min(favGroupEnd, sorted.length - 1));
      }
    }

    // Number keys: jump to session (1-9)
    if (input >= '1' && input <= '9') {
      const idx = parseInt(input) - 1;
      if (idx < sorted.length) moveCursor(idx);
    }

    // Actions
    if (key.return && sorted[cursor]) onSelect(sorted[cursor]!);
    if (input === '/' && sorted[cursor]) onSend(sorted[cursor]!);
    if (input === 'p' && sorted[cursor]) onPeek(sorted[cursor]!);
    if (input === 'f' && sorted[cursor]) onToggleFavorite(sorted[cursor]!);
    if (input === 'r' && sorted[cursor]) onRefresh(sorted[cursor]!);
    if (input === 'x' && sorted[cursor]) setConfirmKill(true);
    if (input === 'g' && sorted[cursor]) onGo(sorted[cursor]!);

    if (input === 'n') onNewSession();
    if (input === 'q' || (key.ctrl && input === 'c')) setConfirmQuit(true);
  });

  const hasFavorites = favorites.length > 0;
  const hasNonFavorites = stableNonFavorites.length > 0;
  const nonTmuxStart = stableNonFavorites.findIndex(s => !s.hasTmux);
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

        const showNonTmuxSep = i === nonTmuxSortedStart && nonTmuxSortedStart > 0;
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
              {session.label && <Text inverse={isCursor} color={isCursor ? 'cyan' : 'blue'} bold>[{session.label}] </Text>}<Text inverse={isCursor} color={isCursor ? 'cyan' : undefined} dimColor={!isCursor && isDim}>{truncate(session.summaryLoading ? '⟳ summarizing...' : (session.goalSummary ?? session.contextSummary ?? session.currentTask ?? 'New session'), maxTaskWidth - (session.label ? session.label.length + 3 : 0))}</Text>
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

      {/* Kill confirmation popup */}
      {confirmKill && sorted[cursor] && (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={2} paddingY={0} justifyContent="center">
          <Text color="red">Kill {sorted[cursor]!.label ?? sorted[cursor]!.projectName} (PID {sorted[cursor]!.pid})?  </Text>
          <Text bold color="green">[y] Yes  </Text>
          <Text bold color="red">[n] No</Text>
        </Box>
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
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text dimColor>  </Text>
            <Text color="green">●</Text><Text dimColor> Running  </Text>
            <Text color="yellow">◐</Text><Text dimColor> Thinking  </Text>
            <Text color="cyan">◑</Text><Text dimColor> Agent  </Text>
            <Text color="white">○</Text><Text dimColor> Idle  </Text>
            <Text color="red">✕</Text><Text dimColor> Dead</Text>
          </Box>
          <Box>
            <Text dimColor>  [j/k] Nav  [{`[/]`}] Group  [1-9] Jump  │  [Enter] Detail  [p] Peek  [g] Go  [/] Send  │  [f] Fav  [n] New  [r] Refresh  [x] Kill  [q] Quit</Text>
          </Box>
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
