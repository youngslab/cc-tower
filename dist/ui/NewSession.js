import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
export function NewSession({ projects, onSelect, onCancel }) {
    const [cursor, setCursor] = useState(0);
    const [customPath, setCustomPath] = useState('');
    const [mode, setMode] = useState('list');
    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }
        if (mode === 'list') {
            if (key.upArrow || input === 'k')
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || input === 'j')
                setCursor(c => Math.min(projects.length, c + 1));
            if (key.return) {
                if (cursor === projects.length) {
                    setMode('custom');
                }
                else if (projects[cursor]) {
                    onSelect(projects[cursor].path);
                }
            }
        }
        else {
            if (key.return && customPath.trim()) {
                onSelect(customPath.trim());
            }
            if (key.backspace || key.delete) {
                setCustomPath(p => p.slice(0, -1));
            }
            else if (input && !key.ctrl && !key.meta) {
                setCustomPath(p => p + input);
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "New Claude Session" }), _jsx(Text, { dimColor: true, children: "Select a recent project or enter a custom path" }), _jsx(Text, { children: " " }), mode === 'list' ? (_jsxs(_Fragment, { children: [projects.map((p, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', p.name] }), _jsxs(Text, { dimColor: true, children: [" ", p.path] })] }, p.path))), _jsx(Box, { children: _jsxs(Text, { color: cursor === projects.length ? 'cyan' : undefined, bold: cursor === projects.length, children: [cursor === projects.length ? '▸ ' : '  ', "Enter custom path..."] }) }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc cancel" })] })) : (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { children: "Path: " }), _jsx(Text, { color: "cyan", children: customPath }), _jsx(Text, { color: "gray", children: "\u258B" })] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Enter confirm \u00B7 Esc cancel" })] }))] }));
}
//# sourceMappingURL=NewSession.js.map