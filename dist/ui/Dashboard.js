import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { EmptyState } from './EmptyState.js';
const STATUS_ICONS = {
    executing: { icon: '●', color: 'green' },
    thinking: { icon: '◐', color: 'yellow' },
    agent: { icon: '◑', color: 'cyan' },
    idle: { icon: '○', color: 'white' },
    dead: { icon: '✕', color: 'red' },
};
export function Dashboard({ sessions, tmuxCount, maxTaskWidth, cursorIdentity, onCursorChange, onSwapFavoriteOrder, onSelect, onSend, onPeek, onToggleFavorite, onNewSession, onRefresh, onKill, onGo, onQuit, onDisplayOrderChange, initialDisplayOrder }) {
    const [confirmQuit, setConfirmQuit] = useState(false);
    const [confirmKill, setConfirmKill] = useState(false);
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
                onSwapFavoriteOrder(sorted[cursor].sessionId, sorted[cursor - 1].sessionId);
            }
            else if (!inFav && cursor > favGroupEnd) {
                const idx = cursor - favGroupEnd;
                const a = nonFavOrderRef.current[idx];
                const b = nonFavOrderRef.current[idx - 1];
                nonFavOrderRef.current[idx] = b;
                nonFavOrderRef.current[idx - 1] = a;
            }
        }
        if (input === ']' && sorted[cursor]) {
            const inFav = cursor < favGroupEnd;
            if (inFav && cursor < favGroupEnd - 1) {
                onSwapFavoriteOrder(sorted[cursor].sessionId, sorted[cursor + 1].sessionId);
            }
            else if (!inFav && cursor < sorted.length - 1) {
                const idx = cursor - favGroupEnd;
                const a = nonFavOrderRef.current[idx];
                const b = nonFavOrderRef.current[idx + 1];
                nonFavOrderRef.current[idx] = b;
                nonFavOrderRef.current[idx + 1] = a;
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
        if (input === '/' && sorted[cursor])
            onSend(sorted[cursor]);
        if (input === 'p' && sorted[cursor])
            onPeek(sorted[cursor]);
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
        if (input === 'q' || (key.ctrl && input === 'c'))
            setConfirmQuit(true);
    });
    const hasFavorites = favorites.length > 0;
    const hasNonFavorites = stableNonFavorites.length > 0;
    const nonTmuxStart = stableNonFavorites.findIndex(s => !s.hasTmux);
    const nonTmuxSortedStart = nonTmuxStart >= 0 ? favorites.length + nonTmuxStart : -1;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, dimColor: true, children: pad('', 4) }), _jsx(Text, { bold: true, dimColor: true, children: pad('LABEL', 16) }), _jsx(Text, { bold: true, dimColor: true, children: pad('', 3) }), _jsx(Text, { bold: true, dimColor: true, children: pad('SESSION', 14) }), _jsx(Text, { bold: true, dimColor: true, children: pad('GOAL', maxTaskWidth) })] }), sorted.map((session, i) => {
                const isCursor = i === cursor;
                const isDim = !session.hasTmux || session.status === 'dead';
                const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle'];
                const showNonTmuxSep = i === nonTmuxSortedStart && nonTmuxSortedStart > 0;
                const showFavSep = hasFavorites && hasNonFavorites && i === favorites.length;
                const labelText = (session.favorite ? '★ ' : '') + (session.sshTarget ? '⌁ ' : '') + session.projectName;
                return (_jsxs(React.Fragment, { children: [showFavSep && (_jsxs(Text, { dimColor: true, children: ['─'.repeat(60), " favorites \u2191"] })), showNonTmuxSep && (_jsxs(Text, { dimColor: true, children: ['· · · ·'.repeat(5), " (monitor-only)"] })), _jsxs(Box, { children: [_jsx(Text, { inverse: isCursor, color: isCursor ? 'cyan' : undefined, bold: isCursor, children: isCursor ? '▸' : ' ' }), _jsx(Text, { inverse: isCursor, color: isCursor ? 'cyan' : undefined, dimColor: !isCursor, children: pad(`${i + 1}`, 3) }), _jsx(Text, { inverse: isCursor, color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: pad(labelText, 16) }), _jsx(Text, { inverse: isCursor, children: " " }), _jsx(Text, { inverse: isCursor, color: isCursor ? 'cyan' : color, children: pad(icon, 2) }), _jsx(Text, { inverse: isCursor, dimColor: !isCursor, children: pad(truncate(session.label ?? session.sessionId.slice(0, 8), 12), 14) }), _jsx(Text, { inverse: isCursor, color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: truncate(session.summaryLoading ? '⟳ summarizing...' : (session.goalSummary ?? session.contextSummary ?? session.currentTask ?? 'New session'), maxTaskWidth) })] }), session.status === 'idle' && session.nextSteps && (_jsxs(Box, { children: [_jsx(Text, { children: ' ' }), _jsx(Text, { children: pad('', 3) }), _jsx(Text, { children: pad('', 16) }), _jsx(Text, { children: pad('', 3) }), _jsx(Text, { children: pad('', 14) }), _jsxs(Text, { color: "yellow", children: ["\u21B3 ", truncate(session.nextSteps, maxTaskWidth - 2)] })] })), _jsx(Box, { height: 1 })] }, identityOf(session)));
            }), sorted.length === 0 && (_jsx(EmptyState, { inTmux: tmuxCount > 0, hookInstalled: true })), confirmKill && sorted[cursor] && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "red", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsxs(Text, { color: "red", children: ["Kill ", sorted[cursor].label ?? sorted[cursor].projectName, " (PID ", sorted[cursor].pid, ")?  "] }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), confirmQuit && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsx(Text, { color: "yellow", children: "Quit cc-tower?  " }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), !confirmQuit && (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  " }), _jsx(Text, { color: "green", children: "\u25CF" }), _jsx(Text, { dimColor: true, children: " Running  " }), _jsx(Text, { color: "yellow", children: "\u25D0" }), _jsx(Text, { dimColor: true, children: " Thinking  " }), _jsx(Text, { color: "cyan", children: "\u25D1" }), _jsx(Text, { dimColor: true, children: " Agent  " }), _jsx(Text, { color: "white", children: "\u25CB" }), _jsx(Text, { dimColor: true, children: " Idle  " }), _jsx(Text, { color: "red", children: "\u2715" }), _jsx(Text, { dimColor: true, children: " Dead" })] }), _jsx(Box, { children: _jsxs(Text, { dimColor: true, children: ["  [j/k] Nav  [1-9] Jump  [", `[/]`, "] Reorder  \u2502  [Enter] Detail  [p] Peek  [g] Go  [/] Send  \u2502  [f] Fav  [n] New  [r] Refresh  [x] Kill  [q] Quit"] }) })] }))] }));
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