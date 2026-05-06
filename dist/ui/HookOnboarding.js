import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
export function HookOnboarding({ onInstall, onSkip }) {
    const [installing, setInstalling] = useState(false);
    useInput(async (input) => {
        if (input === 'y' && !installing) {
            setInstalling(true);
            await onInstall();
        }
        if (input === 'n')
            onSkip();
    });
    if (installing) {
        return _jsx(Text, { color: "green", children: "Installing hook plugin..." });
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, paddingY: 1, borderStyle: "round", borderColor: "yellow", children: [_jsx(Text, { bold: true, color: "yellow", children: "popmux hook plugin is not installed." }), _jsx(Text, {}), _jsx(Text, { children: "Works without hooks (JSONL fallback)," }), _jsx(Text, { children: "but hooks provide real-time state tracking." }), _jsx(Text, {}), _jsx(Text, { children: "[y] Install now  [n] Later" })] }));
}
//# sourceMappingURL=HookOnboarding.js.map