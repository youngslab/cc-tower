import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
export function SendInput({ session, confirmWhenBusy, onSend, onCancel }) {
    const [text, setText] = useState('');
    const [confirming, setConfirming] = useState(false);
    const isBusy = session.status === 'thinking' || session.status === 'executing' || session.status === 'agent';
    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.return) {
            if (!text.trim())
                return;
            if (isBusy && confirmWhenBusy && !confirming) {
                setConfirming(true);
                return;
            }
            onSend(text);
            return;
        }
        if (key.backspace || key.delete) {
            setText(t => t.slice(0, -1));
            return;
        }
        if (confirming) {
            if (input === 'y') {
                onSend(text);
                return;
            }
            if (input === 'n') {
                setConfirming(false);
                return;
            }
            return;
        }
        if (input && !key.ctrl && !key.meta) {
            setText(t => t + input);
        }
    });
    if (!session.hasTmux) {
        return (_jsx(Box, { paddingX: 1, children: _jsx(Text, { color: "yellow", children: "This session is not connected to tmux." }) }));
    }
    if (confirming) {
        return (_jsx(Box, { paddingX: 1, flexDirection: "column", children: _jsx(Text, { color: "yellow", children: "Session is busy. Send anyway? [y/n]" }) }));
    }
    return (_jsxs(Box, { paddingX: 1, children: [_jsxs(Text, { children: ["Send to ", session.label ?? session.projectName, ": "] }), _jsx(Text, { color: "green", children: text }), _jsx(Text, { dimColor: true, children: "\u2588" })] }));
}
//# sourceMappingURL=SendInput.js.map