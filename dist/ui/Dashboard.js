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
export function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onQuit }) {
    const [cursor, setCursor] = useState(0);
    const [confirmQuit, setConfirmQuit] = useState(false);
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
            setCursor(c => Math.min(sessions.length - 1, c + 1));
        // Number keys: jump to session (1-9)
        if (input >= '1' && input <= '9') {
            const idx = parseInt(input) - 1;
            if (idx < sessions.length)
                setCursor(idx);
        }
        // Actions
        if (key.return && sessions[cursor])
            onSelect(sessions[cursor]);
        if (input === '/' && sessions[cursor])
            onSend(sessions[cursor]);
        if (input === 'p' && sessions[cursor])
            onPeek(sessions[cursor]);
        // Quit with confirmation
        if (input === 'q' || (key.ctrl && input === 'c'))
            setConfirmQuit(true);
    });
    const nonTmuxStart = sessions.findIndex(s => !s.hasTmux);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "cc-tower" }), _jsxs(Text, { children: [" \u2014 ", sessions.length, " sessions"] })] }), _jsxs(Box, { children: [_jsx(Text, { bold: true, children: "   " }), _jsx(Text, { bold: true, dimColor: true, children: pad('PANE', 7) }), _jsx(Text, { bold: true, dimColor: true, children: pad('HOST', 9) }), _jsx(Text, { bold: true, dimColor: true, children: pad('LABEL', 18) }), _jsx(Text, { bold: true, dimColor: true, children: pad('STATUS', 14) }), _jsx(Text, { bold: true, dimColor: true, children: "TASK" })] }), sessions.map((session, i) => {
                const isCursor = i === cursor;
                const isDim = !session.hasTmux || session.status === 'dead';
                const { icon, color } = STATUS_ICONS[session.status] ?? STATUS_ICONS['idle'];
                // Separator before non-tmux sessions
                const showSep = i === nonTmuxStart && nonTmuxStart > 0;
                return (_jsxs(React.Fragment, { children: [showSep && (_jsxs(Text, { dimColor: true, children: ['─'.repeat(60), " (monitor-only)"] })), _jsxs(Box, { children: [_jsx(Text, { children: isCursor ? '▸' : ' ' }), _jsx(Text, { dimColor: true, children: pad(`${i + 1}`, 3) }), _jsx(Text, { dimColor: isDim, children: pad(session.paneId ?? '—', 7) }), _jsx(Text, { dimColor: isDim, children: pad(session.host, 9) }), _jsx(Text, { dimColor: isDim, children: pad(session.label ?? session.projectName, 18) }), _jsx(Text, { color: isDim ? 'gray' : color, children: pad(`${icon} ${session.status.toUpperCase()}`, 14) }), _jsx(Text, { dimColor: isDim, children: truncate(session.contextSummary ?? session.currentActivity ?? session.currentTask ?? (session.summaryLoading ? '⟳ summarizing...' : ''), maxTaskWidth) })] })] }, session.sessionId));
            }), sessions.length === 0 && (_jsx(EmptyState, { inTmux: tmuxCount > 0, hookInstalled: true })), confirmQuit && (_jsxs(Box, { marginTop: 1, borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 0, justifyContent: "center", children: [_jsx(Text, { color: "yellow", children: "Quit cc-tower?  " }), _jsx(Text, { bold: true, color: "green", children: "[y] Yes  " }), _jsx(Text, { bold: true, color: "red", children: "[n] No" })] })), !confirmQuit && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "[j/k] Navigate  [1-9] Jump  [Enter] Detail  [p] Peek  [/] Send  [q] Quit" }) }))] }));
}
function pad(str, len) {
    return str.slice(0, len).padEnd(len);
}
function truncate(str, max) {
    if (str.length <= max)
        return str;
    return str.slice(0, max - 1) + '…';
}
//# sourceMappingURL=Dashboard.js.map