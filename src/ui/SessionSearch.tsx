import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Session } from '../core/session-store.js';
import { fuzzyMatch } from './fuzzy.js';

interface Props {
  sessions: Session[];
  /** Called when a result is chosen (Enter). The dashboard moves its cursor here. */
  onSelect: (session: Session) => void;
  /** Called on Escape — close the overlay without selecting. */
  onCancel: () => void;
}

/**
 * Fuzzy-search overlay over named sessions. Typing filters by `label`
 * (subsequence match); Enter selects the highlighted result. Selection does
 * NOT navigate — the caller repositions the dashboard cursor to that session.
 *
 * Navigation is arrow-only so every printable character (incl. j/k) is typeable
 * into the query.
 */
export function SessionSearch({ sessions, onSelect, onCancel }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  // Only sessions with a user-defined name are searchable.
  const named = sessions.filter(s => s.label);
  const filtered = query ? named.filter(s => fuzzyMatch(query, s.label!)) : named;
  const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      const chosen = filtered[safeCursor];
      if (chosen) onSelect(chosen);
      return;
    }
    if (key.upArrow) { setCursor(c => Math.max(0, Math.min(c, filtered.length - 1) - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(filtered.length - 1, c + 1)); return; }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setCursor(0); return; }
    if (input && !key.ctrl && !key.meta) { setQuery(q => q + input); setCursor(0); }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Search sessions </Text>
        <Text dimColor>(by name)</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/ </Text>
        <Text color="cyan">{query}</Text>
        <Text dimColor>█</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {named.length === 0 && (
          <Text dimColor>No named sessions yet.</Text>
        )}
        {named.length > 0 && filtered.length === 0 && (
          <Text dimColor>No matches.</Text>
        )}
        {filtered.map((s, i) => {
          const isCursor = i === safeCursor;
          const name = `${s.label!} · ${s.projectName}`;
          return (
            <Box key={s.paneId ?? String(s.pid)}>
              <Text color={isCursor ? 'cyan' : undefined} bold={isCursor}>
                {isCursor ? '▸ ' : '  '}{name}
              </Text>
              {s.sshTarget && <Text dimColor>  (remote)</Text>}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>  ↑↓ navigate · type to search · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
