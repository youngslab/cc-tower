import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { basename } from 'node:path';
import { PastSessionByCwd } from './NewSession.js';
import { fuzzyMatch } from './fuzzy.js';

interface Props {
  /** Getter; re-invoked whenever `generation` changes (the disk scan completes). */
  getSessions: () => PastSessionByCwd[];
  /** Bumped by the caller when the background scan finishes, to refresh the list. */
  generation?: number;
  /** True while the first (cold) disk scan is in flight — shows a footer hint. */
  scanning?: boolean;
  /** Called when a past session is chosen (Enter) — caller resurrects it. */
  onSelect: (session: PastSessionByCwd) => void;
  /** Called on Escape — close the overlay without resurrecting. */
  onCancel: () => void;
  /** Terminal height, for viewport scrolling — the list can be much longer
   * than the screen (100+ resumable sessions), and every row is fixed-height
   * (unlike Dashboard's session blocks), so a simple centered window suffices. */
  termHeight?: number;
}

// Rows consumed above/below the list itself: title(1) + margin+query(2) +
// list-container margin(1) + footer margin+text(2).
const CHROME_ROWS = 6;

/**
 * Fuzzy-search overlay over DEAD/past sessions. Enter resurrects the chosen
 * session via `claude --resume`. Searches by label and the cwd basename
 * (past sessions frequently have no label). Navigation is arrow-only so every
 * printable character (incl. j/k) is typeable into the query.
 */
export function ResumeSearch({ getSessions, generation = 0, scanning = false, onSelect, onCancel, termHeight = 24 }: Props) {
  // Re-snapshot when `generation` changes (i.e. the background scan completes),
  // preserving query/cursor (no remount). Only sessions with a name (label from
  // /rename, or a summary) are listed — unnamed ones are noise.
  const sessions = useMemo(
    () => getSessions().filter(s => s.label || s.goalSummary || s.contextSummary),
    [generation],
  );
  const [query, setQuery] = useState('');
  // Identity-based cursor (selected sessionId, not an array index) — the
  // underlying list can shrink out from under the user (e.g. an orphaned
  // entry gets hidden once the background scan completes and `generation`
  // bumps). An index-based cursor would silently point at whatever item
  // slid into that slot, making navigation feel like it "skipped" an item.
  // Mirrors Dashboard's `cursorIdentity` pattern for the same reason.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Search by name only (label + summary) — the workspace path is not searched.
  const filtered = query
    ? sessions.filter(s =>
        fuzzyMatch(query, s.label ?? '') ||
        fuzzyMatch(query, s.goalSummary ?? s.contextSummary ?? ''))
    : sessions;
  // Resolve the identity to its current position; falls back to the top of
  // the list when the selected session vanished (scanned away) or on first
  // render.
  const foundIdx = selectedId === null ? -1 : filtered.findIndex(s => s.sessionId === selectedId);
  const cursorIdx = foundIdx >= 0 ? foundIdx : 0;

  // Viewport scrolling: keep the cursor centered in the visible window rather
  // than rendering the whole (possibly 100+ item) list and relying on the
  // terminal's own scrollback, which doesn't track the highlighted row.
  const available = Math.max(3, termHeight - CHROME_ROWS);
  let viewStart = 0;
  if (filtered.length > available) {
    viewStart = Math.min(
      Math.max(0, cursorIdx - Math.floor(available / 2)),
      filtered.length - available,
    );
  }
  const viewEnd = Math.min(filtered.length, viewStart + available);
  const showScrollUp = viewStart > 0;
  const showScrollDown = viewEnd < filtered.length;

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      const chosen = filtered[cursorIdx];
      if (chosen) onSelect(chosen);
      return;
    }
    if (key.upArrow) {
      const next = filtered[Math.max(0, cursorIdx - 1)];
      if (next) setSelectedId(next.sessionId);
      return;
    }
    if (key.downArrow) {
      const next = filtered[Math.min(filtered.length - 1, cursorIdx + 1)];
      if (next) setSelectedId(next.sessionId);
      return;
    }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setSelectedId(null); return; }
    if (input && !key.ctrl && !key.meta) { setQuery(q => q + input); setSelectedId(null); }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Resume past session </Text>
        <Text dimColor>(claude --resume)</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>R </Text>
        <Text color="cyan">{query}</Text>
        <Text dimColor>█</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {sessions.length === 0 && (
          <Text dimColor>{scanning ? 'Scanning all sessions…' : 'No past sessions to resume.'}</Text>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <Text dimColor>No match.</Text>
        )}
        {showScrollUp && <Text dimColor>  ↑ {viewStart} more</Text>}
        {filtered.slice(viewStart, viewEnd).map((s, localI) => {
          const i = viewStart + localI;
          const isCursor = i === cursorIdx;
          const summary = s.goalSummary ?? s.contextSummary;
          // Unlabeled sessions show their summary as the name (more useful than
          // a row of identical '(unnamed)' entries for the same project).
          const name = s.label ?? (summary ? truncate(summary, 50) : '(unnamed)');
          return (
            <Box key={s.sessionId}>
              <Text color={isCursor ? 'cyan' : undefined} bold={isCursor}>
                {isCursor ? '▸ ' : '  '}{name}
              </Text>
              <Text dimColor> · {basename(s.cwd)} · {formatAge(s.startedAt)}</Text>
              {s.sshTarget && <Text dimColor>  (remote)</Text>}
            </Box>
          );
        })}
        {showScrollDown && <Text dimColor>  ↓ {filtered.length - viewEnd} more</Text>}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>  ↑↓ navigate · type to search · Enter resume · Esc cancel</Text>
        {scanning && <Text color="yellow"> · scanning all sessions…</Text>}
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatAge(startedAt: number): string {
  if (!startedAt) return '?';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
