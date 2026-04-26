import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
const STATUS_ICONS = {
    executing: { icon: '●', color: 'green' },
    thinking: { icon: '◐', color: 'yellow' },
    agent: { icon: '◑', color: 'cyan' },
    idle: { icon: '○', color: 'white' },
    dead: { icon: '✕', color: 'red' },
};
export function DetailView({ session, onBack, onSend, onPeek }) {
    useInput((input, key) => {
        if (input === 'b' || key.escape)
            onBack();
        if (input === '/')
            onSend(session);
        if (input === 'p')
            onPeek(session);
    });
    const elapsed = formatDuration(Date.now() - session.startedAt.getTime());
    const { icon, color } = STATUS_ICONS[session.status] ?? { icon: '○', color: 'gray' };
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Session: ", session.label ?? session.projectName] }), _jsxs(Text, { children: [" (", session.paneId ?? 'no pane', ")"] }), session.favorite && _jsx(Text, { color: "yellow", children: "  \u2605 Favorite" })] }), _jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Instance \u2500\u2500" }), _jsxs(Text, { children: ["  PID:      ", session.pid] }), _jsxs(Text, { children: ["  Pane:     ", session.paneId ?? '—'] }), _jsxs(Text, { children: ["  Identity: ", session.paneId ?? String(session.pid)] }), _jsxs(Text, { children: ["  Mode:     ", session.detectionMode] }), _jsxs(Text, { children: ["  Status:   ", _jsxs(Text, { color: color, children: [icon, " ", session.status.toUpperCase()] })] }), _jsxs(Text, { children: ["  Started:  ", elapsed, " ago"] })] }), _jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Session \u2500\u2500" }), _jsxs(Text, { children: ["  ID:      ", session.sessionId] }), _jsxs(Text, { children: ["  Name:    ", session.label ?? '(none)'] }), _jsxs(Text, { children: ["  Project: ", session.cwd] }), _jsxs(Text, { children: ["  Host:    ", session.host, session.sshTarget ? ` (${session.sshTarget})` : ''] })] }), _jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Stats \u2500\u2500" }), _jsxs(Text, { children: ["  Messages: ", session.messageCount, "  \u2502  Tools: ", session.toolCallCount, "  \u2502  Cost: ~$", (session.estimatedCost ?? 0).toFixed(2)] })] }), session.goalSummary && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Goal \u2500\u2500" }), _jsx(Text, { color: "cyan", children: session.goalSummary })] })), session.contextSummary && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Now \u2500\u2500" }), _jsx(Text, { color: "green", children: session.contextSummary })] })), session.currentTask && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Last Request \u2500\u2500" }), _jsx(Text, { children: session.currentTask })] })), session.currentActivity && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Current Activity \u2500\u2500" }), _jsx(Text, { dimColor: true, children: session.currentActivity })] })), session.nextSteps && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Action Item \u2500\u2500" }), _jsx(Text, { color: "yellow", children: session.nextSteps })] })), session.sshTarget && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "Remote" }), _jsxs(Text, { children: ["  Host: ", session.host] }), _jsxs(Text, { children: ["  SSH: ", session.sshTarget] }), session.paneId && _jsxs(Text, { children: ["  Pane: ", session.paneId] }), session.commandPrefix && _jsxs(Text, { children: ["  Prefix: ", session.commandPrefix] })] })), !session.sshTarget && session.paneId && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "Terminal" }), _jsxs(Text, { children: ["  Pane: ", session.paneId] })] })), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "[/] Send  [p] Peek  [b] Back" }) })] }));
}
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}
//# sourceMappingURL=DetailView.js.map