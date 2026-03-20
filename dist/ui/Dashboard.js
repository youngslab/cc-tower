import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EmptyState } from './EmptyState.js';
const STATUS_ICONS = {
    executing: { icon: '●', color: 'green' },
    thinking: { icon: '◐', color: 'yellow' },
    agent: { icon: '◑', color: 'cyan' },
    idle: { icon: '○', color: 'white' },
    dead: { icon: '✕', color: 'red' },
};
export function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onToggleFavorite, onNewSession, onRefresh, onQuit }) {
    const [cursor, setCursor] = useState(0);
    const [confirmQuit, setConfirmQuit] = useState(false);
    // Sort: favorites (stable order) → tmux sessions (by status) → non-tmux sessions (by status)
    const favorites = sessions.filter(s => s.favorite).sort((a, b) => (a.favoritedAt ?? 0) - (b.favoritedAt ?? 0));
    const nonFavorites = sessions.filter(s => !s.favorite);
    const sorted = [...favorites, ...nonFavorites];
    useInput((input, key) => {
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
            setCursor(c => Math.max(0, c - 1));
        if (key.downArrow || input === 'j')
            setCursor(c => Math.min(sorted.length - 1, c + 1));
        // Number keys: jump to session (1-9)
        if (input >= '1' && input <= '9') {
            const idx = parseInt(input) - 1;
            if (idx < sorted.length)
                setCursor(idx);
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
        // Quit with confirmation
        if (input === 'n')
            onNewSession();
        if (input === 'q' || (key.ctrl && input === 'c'))
            setConfirmQuit(true);
    });
    const hasFavorites = favorites.length > 0;
    const hasNonFavorites = nonFavorites.length > 0;
    const nonTmuxStart = nonFavorites.findIndex(s => !s.hasTmux);
    // Index in sorted array where non-tmux non-favorites start
    const nonTmuxSortedStart = nonTmuxStart >= 0 ? favorites.length + nonTmuxStart : -1;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "   " }), _jsx(Text, { bold: true, dimColor: true, children: pad('PANE', 7) }), _jsx(Text, { bold: true, dimColor: true, children: pad('HOST', 9) }), _jsx(Text, { bold: true, dimColor: true, children: pad('LABEL', 18) }), _jsx(Text, { bold: true, dimColor: true, children: pad('STATUS', 14) }), _jsx(Text, { bold: true, dimColor: true, children: "GOAL" })] }), sorted.map((session, i) => {
                const isCursor = i === cursor;
                const isDim = !session.hasTmux || session.status === 'dead';
                const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle'];
                // Separator before non-tmux non-favorite sessions
                const showNonTmuxSep = i === nonTmuxSortedStart && nonTmuxSortedStart > 0;
                // Separator between favorites and non-favorites
                const showFavSep = hasFavorites && hasNonFavorites && i === favorites.length;
                const labelText = (session.favorite ? '★ ' : '') + session.projectName;
                return (_jsxs(React.Fragment, { children: [showFavSep && (_jsxs(Text, { dimColor: true, children: ['─'.repeat(60), " favorites \u2191"] })), showNonTmuxSep && (_jsxs(Text, { dimColor: true, children: ['─'.repeat(60), " (monitor-only)"] })), _jsxs(Box, { children: [_jsx(Text, { color: isCursor ? 'cyan' : undefined, bold: isCursor, children: isCursor ? '▸' : ' ' }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor, children: pad(`${i + 1}`, 3) }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: pad(session.paneId ?? '—', 7) }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: pad(session.host, 9) }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: pad(labelText, 18) }), _jsx(Text, { color: isCursor ? 'cyan' : (isDim ? 'gray' : color), children: pad(`${icon} ${session.status.toUpperCase()}`, 14) }), session.label && _jsxs(Text, { color: isCursor ? 'cyan' : 'blue', bold: true, children: ["[", session.label, "] "] }), _jsx(Text, { color: isCursor ? 'cyan' : undefined, dimColor: !isCursor && isDim, children: truncate(session.goalSummary ?? session.contextSummary ?? session.currentTask ?? (session.summaryLoading ? '⟳ summarizing...' : ''), maxTaskWidth - (session.label ? session.label.length + 3 : 0)) })] }), session.status === 'idle' && session.nextSteps && (_jsx(Box, { paddingLeft: 52, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", truncate(session.nextSteps, maxTaskWidth)] }) }))] }, session.sessionId));
            }), sorted.length === 0 && (_jsx(EmptyState, { inTmux: tmuxCount > 0, hookInstalled: true })), confirmQuit && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsx(Text, { color: "yellow", children: "Quit cc-tower?  " }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), !confirmQuit && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "[j/k] Navigate  [1-9] Jump  [Enter] Detail  [p] Peek  [/] Send  [f] Fav  [n] New  [q] Quit" }) }))] }));
}
import stringWidth from 'string-width';
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