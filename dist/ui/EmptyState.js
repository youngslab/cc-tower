import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
export function EmptyState({ inTmux, hookInstalled }) {
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, paddingY: 1, children: [!inTmux && (_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "yellow", children: "\u26A0 Not in tmux. Peek/Send will not work." }) })), _jsx(Text, { children: "No active Claude Code sessions." }), _jsx(Text, { dimColor: true, children: "Sessions will be auto-detected when claude is running." }), !hookInstalled && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "yellow", children: "\u26A0 Hook plugin not installed \u2014 run popmux install-hooks for real-time tracking" }) }))] }));
}
//# sourceMappingURL=EmptyState.js.map