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
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Session: ", session.label ?? session.projectName] }), _jsxs(Text, { children: [" (", session.paneId ?? 'no pane', ")"] })] }), _jsxs(Box, { flexDirection: "column", paddingX: 2, children: [_jsxs(Text, { children: ["Project:  ", session.cwd] }), _jsxs(Text, { children: ["Host:     ", session.host, session.sshTarget ? ` (${session.sshTarget})` : ''] }), _jsxs(Text, { children: ["PID:      ", session.pid, "  \u2502  Pane: ", session.paneId ?? '—', "  \u2502  Mode: ", session.detectionMode] }), _jsxs(Text, { children: ["Status:   ", _jsxs(Text, { color: color, children: [icon, " ", session.status.toUpperCase()] })] }), _jsxs(Text, { children: ["Started:  ", elapsed, " ago"] }), _jsxs(Text, { children: ["Messages: ", session.messageCount, "  \u2502  Tools: ", session.toolCallCount, "  \u2502  Cost: ~$", (session.estimatedCost ?? 0).toFixed(2)] })] }), session.contextSummary && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Context \u2500\u2500" }), _jsx(Text, { color: "cyan", children: session.contextSummary })] })), session.currentTask && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Last Request \u2500\u2500" }), _jsx(Text, { children: session.currentTask })] })), session.currentActivity && (_jsxs(Box, { marginTop: 1, paddingX: 2, flexDirection: "column", children: [_jsx(Text, { bold: true, dimColor: true, children: "\u2500\u2500 Current Activity \u2500\u2500" }), _jsx(Text, { dimColor: true, children: session.currentActivity })] })), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "[/] Send  [p] Peek  [b] Back" }) })] }));
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