import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useRef, useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import { EmptyState } from './EmptyState.js';
const STATUS_ICONS = {
    executing: { icon: '●', color: 'green' },
    thinking: { icon: '◐', color: 'yellow' },
    agent: { icon: '◑', color: 'cyan' },
    idle: { icon: '○', color: 'white' },
    dead: { icon: '✕', color: 'red' },
};
export function Dashboard({ sessions, tmuxCount, maxTaskWidth, termWidth, termHeight, headerHeight, cursorIdentity, onCursorChange, onSwapFavoriteOrder, onSelect, onOpenSearch, onOpenResumeSearch, onToggleFavorite, onNewSession, onRefresh, onKill, onGo, onQuit, onDisplayOrderChange, initialDisplayOrder, pickerMode }) {
    const [confirmQuit, setConfirmQuit] = useState(false);
    const [confirmKill, setConfirmKill] = useState(false);
    const [, forceUpdate] = useReducer(x => x + 1, 0);
    // Stable order ref for non-favorites — order doesn't change on status updates
    // Initialize from persisted displayOrder on first mount
    const nonFavOrderRef = useRef(initialDisplayOrder);
    // Favorites: sorted by favoritedAt (stable, time-based)
    const favorites = sessions.filter(s => s.favorite).sort((a, b) => (a.favoritedAt ?? 0) - (b.favoritedAt ?? 0));
    const nonFavorites = sessions.filter(s => !s.favorite);
    // Update stable non-favorite order: keyed by identity (paneId/pid) — survives session changes
    const identityOf = (s) => s.paneId ?? String(s.pid);
    const currentNonFavIdentities = new Set(nonFavorites.map(identityOf));
    const existingInOrder = new Set(nonFavOrderRef.current);
    const stableNonFavOrder = nonFavOrderRef.current.filter(id => currentNonFavIdentities.has(id));
    for (const s of nonFavorites) {
        if (!existingInOrder.has(identityOf(s)))
            stableNonFavOrder.push(identityOf(s));
    }
    if (stableNonFavOrder.join(',') !== nonFavOrderRef.current.join(',')) {
        nonFavOrderRef.current = stableNonFavOrder;
        onDisplayOrderChange(stableNonFavOrder);
    }
    else {
        nonFavOrderRef.current = stableNonFavOrder;
    }
    const identityMap = new Map(sessions.map(s => [identityOf(s), s]));
    const stableNonFavorites = stableNonFavOrder.map(id => identityMap.get(id)).filter(Boolean);
    const sorted = [...favorites, ...stableNonFavorites];
    // Resolve cursor index from tracked identity (go to 0 if session is gone)
    const cursor = (() => {
        if (!cursorIdentity)
            return 0;
        const idx = sorted.findIndex(s => identityOf(s) === cursorIdentity);
        return idx >= 0 ? idx : 0;
    })();
    const moveCursor = (newIdx) => {
        const session = sorted[newIdx];
        onCursorChange(session ? identityOf(session) : null);
    };
    // Group boundary: index where non-favorites start
    const favGroupEnd = favorites.length;
    useInput((input, key) => {
        // Kill confirmation mode
        if (confirmKill) {
            if (input === 'y' && sorted[cursor]) {
                onKill(sorted[cursor]);
                setConfirmKill(false);
            }
            if (input === 'n' || key.escape)
                setConfirmKill(false);
            return;
        }
        // Quit confirmation mode
        if (confirmQuit) {
            if (input === 'y')
                onQuit();
            if (input === 'n' || key.escape)
                setConfirmQuit(false);
            return;
        }
        // Navigation: arrow keys + j/k (vim style)
        if (key.upArrow || input === 'k')
            moveCursor(Math.max(0, cursor - 1));
        if (key.downArrow || input === 'j')
            moveCursor(Math.min(sorted.length - 1, cursor + 1));
        // [ / ] = move current session up/down within its group (no cross-group movement)
        // [ / ] = reorder within group. Cursor follows the moved session automatically
        // (cursorSessionId stays the same, position updates after re-render)
        if (input === '[' && sorted[cursor]) {
            const inFav = cursor < favGroupEnd;
            if (inFav && cursor > 0) {
                // cursorIdentity stays as current session → auto-resolves to new position after re-render
                onSwapFavoriteOrder(sorted[cursor].sessionId, sorted[cursor - 1].sessionId);
            }
            else if (!inFav && cursor > favGroupEnd) {
                const idx = cursor - favGroupEnd;
                const newOrder = [...nonFavOrderRef.current];
                [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
                nonFavOrderRef.current = newOrder;
                onDisplayOrderChange(newOrder);
                forceUpdate();
            }
        }
        if (input === ']' && sorted[cursor]) {
            const inFav = cursor < favGroupEnd;
            if (inFav && cursor < favGroupEnd - 1) {
                onSwapFavoriteOrder(sorted[cursor].sessionId, sorted[cursor + 1].sessionId);
            }
            else if (!inFav && cursor < sorted.length - 1) {
                const idx = cursor - favGroupEnd;
                const newOrder = [...nonFavOrderRef.current];
                [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
                nonFavOrderRef.current = newOrder;
                onDisplayOrderChange(newOrder);
                forceUpdate();
            }
        }
        // Number keys: jump to session (1-9)
        if (input >= '1' && input <= '9') {
            const idx = parseInt(input) - 1;
            if (idx < sorted.length)
                moveCursor(idx);
        }
        // Actions
        if (key.return && sorted[cursor])
            onSelect(sorted[cursor]);
        if (input === '/')
            onOpenSearch();
        if (input === 'R')
            onOpenResumeSearch();
        if (input === 'f' && sorted[cursor])
            onToggleFavorite(sorted[cursor]);
        if (input === 'r' && sorted[cursor])
            onRefresh(sorted[cursor]);
        if (input === 'x' && sorted[cursor])
            setConfirmKill(true);
        if (input === 'g' && sorted[cursor])
            onGo(sorted[cursor]);
        if (input === 'n')
            onNewSession();
        if (input === 'q' || (key.ctrl && input === 'c')) {
            if (pickerMode) {
                onQuit();
            }
            else {
                setConfirmQuit(true);
            }
        }
    });
    const hasFavorites = favorites.length > 0;
    const hasNonFavorites = stableNonFavorites.length > 0;
    const nonTmuxStart = stableNonFavorites.findIndex(s => !s.hasTmux);
    const nonTmuxSortedStart = nonTmuxStart >= 0 ? favorites.length + nonTmuxStart : -1;
    const itemRowHeight = (s, i) => {
        let h = 3; // name row + summary row + spacer
        if (s.status === 'idle' && s.nextSteps)
            h += 1;
        if (hasFavorites && hasNonFavorites && i === favorites.length)
            h += 1; // fav separator
        if (i === nonTmuxSortedStart && nonTmuxSortedStart > 0)
            h += 1; // non-tmux separator
        return h;
    };
    // footer-marginTop(1) + legend-row(1) + keys-rows(2, always split — see footer
    // below) + scroll-hints(2, always reserved — see below). headerHeight accounts
    // for the logo/border rows App.tsx already renders above us — without it
    // we'd overestimate how much vertical room is left and overflow past the
    // real terminal height.
    const FIXED_OVERHEAD = 6;
    const available = Math.max(4, termHeight - headerHeight - FIXED_OVERHEAD);
    const heights = sorted.map(itemRowHeight);
    let viewStart = 0, viewEnd = sorted.length;
    let usedItemRows = 0;
    if (sorted.length > 0) {
        let used = heights[cursor] ?? 2;
        viewStart = cursor;
        viewEnd = cursor + 1;
        while (viewStart > 0 && used + (heights[viewStart - 1] ?? 2) <= available) {
            viewStart--;
            used += heights[viewStart] ?? 2;
        }
        while (viewEnd < sorted.length && used + (heights[viewEnd] ?? 2) <= available) {
            used += heights[viewEnd] ?? 2;
            viewEnd++;
        }
        // back-fill from start if room remains
        while (viewStart > 0 && used + (heights[viewStart - 1] ?? 2) <= available) {
            viewStart--;
            used += heights[viewStart] ?? 2;
        }
        usedItemRows = used;
    }
    const showScrollUp = viewStart > 0;
    const showScrollDown = viewEnd < sorted.length;
    // Left gutter width for continuation lines (=> summary, ↳ next): aligns under the name
    const INDENT = 8;
    // Anchor the footer to the very bottom of the screen (with a 1-row gap below
    // it) instead of right after the list, which otherwise leaves a ragged gap
    // mid-screen whenever there are too few sessions to fill the viewport.
    // A precisely-sized blank spacer (rather than a fixed-height flex column,
    // which made Ink/yoga misbehave and visibly wrap the footer text) fills the
    // exact leftover space: available room minus the rows the list actually used.
    const spacerRows = Math.max(0, available - usedItemRows);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: showScrollUp ? `  ↑ ${viewStart} more` : ' ' }), sorted.slice(viewStart, viewEnd).map((session, localI) => {
                const i = viewStart + localI;
                const isCursor = i === cursor;
                const isDim = !session.hasTmux || session.status === 'dead';
                const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle'];
                const showNonTmuxSep = i === nonTmuxSortedStart && nonTmuxSortedStart > 0;
                const showFavSep = hasFavorites && hasNonFavorites && i === favorites.length;
                // Name = "label · workspace" when named, else just the workspace (no raw session id)
                const markers = (session.favorite ? '★ ' : '') + (session.sshTarget ? '⌁ ' : '');
                const nameText = markers + (session.label ? `${session.label} · ${session.projectName}` : session.projectName);
                const summaryText = session.summaryLoading
                    ? '⟳ summarizing...'
                    : (session.goalSummary ?? session.contextSummary ?? session.currentTask ?? 'New session');
                return (_jsxs(React.Fragment, { children: [showFavSep && (_jsxs(Text, { dimColor: true, children: ['─'.repeat(60), " favorites \u2191"] })), showNonTmuxSep && (_jsxs(Text, { dimColor: true, children: ['· · · ·'.repeat(5), " (monitor-only)"] })), _jsxs(Box, { children: [_jsx(Text, { color: isCursor ? 'cyan' : undefined, bold: isCursor, children: isCursor ? '▸' : ' ' }), _jsxs(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor, children: [" ", pad(`${i + 1}`, 2), " "] }), _jsxs(Text, { color: isCursor ? 'cyan' : color, children: [icon, " "] }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, bold: isCursor, dimColor: !isCursor && isDim, children: truncate(nameText, maxTaskWidth) }), session.sshTarget && _jsx(Text, { dimColor: true, children: "  (remote)" })] }), _jsxs(Box, { children: [_jsx(Text, { children: ' '.repeat(INDENT) }), _jsx(Text, { dimColor: true, children: '=> ' }), _jsx(Text, { dimColor: !isCursor && isDim, children: truncate(summaryText, maxTaskWidth) })] }), session.status === 'idle' && session.nextSteps && (_jsxs(Box, { children: [_jsx(Text, { children: ' '.repeat(INDENT) }), _jsxs(Text, { color: "yellow", children: ["\u21B3 ", truncate(session.nextSteps, maxTaskWidth)] })] })), _jsx(Box, { height: 1 })] }, identityOf(session)));
            }), sorted.length > 0 && (_jsx(Text, { dimColor: true, children: showScrollDown ? `  ↓ ${sorted.length - viewEnd} more` : ' ' })), sorted.length === 0 && (_jsx(EmptyState, { inTmux: tmuxCount > 0, hookInstalled: true })), spacerRows > 0 && _jsx(Box, { height: spacerRows }), confirmKill && sorted[cursor] && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "red", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsxs(Text, { color: "red", children: ["Kill ", sorted[cursor].label ?? sorted[cursor].projectName, " (PID ", sorted[cursor].pid, ")?  "] }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), confirmQuit && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsx(Text, { color: "yellow", children: "Quit popmux?  " }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), !confirmQuit && (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  " }), _jsx(Text, { color: "green", children: "\u25CF" }), _jsx(Text, { dimColor: true, children: " Running  " }), _jsx(Text, { color: "yellow", children: "\u25D0" }), _jsx(Text, { dimColor: true, children: " Thinking  " }), _jsx(Text, { color: "cyan", children: "\u25D1" }), _jsx(Text, { dimColor: true, children: " Agent  " }), _jsx(Text, { color: "white", children: "\u25CB" }), _jsx(Text, { dimColor: true, children: " Idle  " }), _jsx(Text, { color: "red", children: "\u2715" }), _jsx(Text, { dimColor: true, children: " Dead" })] }), _jsx(Box, { children: _jsxs(Text, { dimColor: true, children: ["  [j/k] Nav  [1-9] Jump  [", `[/]`, "] Reorder  \u2502  [Enter] Detail  [g] Go"] }) }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: "  [/] Search  [R] Resume  \u2502  [f] Fav  [n] New  [r] Refresh  [x] Kill  [q] Quit" }) })] }))] }));
}
import stringWidth from 'string-width';
function centerPad(str, len) {
    const w = stringWidth(str);
    if (w >= len)
        return str;
    const left = Math.floor((len - w) / 2);
    const right = len - w - left;
    return ' '.repeat(left) + str + ' '.repeat(right);
}
function pad(str, len) {
    const truncated = truncate(str, len);
    const w = stringWidth(truncated);
    return w < len ? truncated + ' '.repeat(len - w) : truncated;
}
function truncate(str, max) {
    if (stringWidth(str) <= max)
        return str;
    let result = '';
    let w = 0;
    for (const ch of str) {
        const cw = stringWidth(ch);
        if (w + cw > max - 1)
            break;
        result += ch;
        w += cw;
    }
    return result + '…';
}
//# sourceMappingURL=Dashboard.js.map