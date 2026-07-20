import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { fuzzyMatch } from './fuzzy.js';
/**
 * Fuzzy-search overlay over named sessions. Typing filters by `label`
 * (subsequence match); Enter selects the highlighted result. Selection does
 * NOT navigate — the caller repositions the dashboard cursor to that session.
 *
 * Navigation is arrow-only so every printable character (incl. j/k) is typeable
 * into the query.
 */
export function SessionSearch({ sessions, onSelect, onCancel }) {
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    // Only sessions with a user-defined name are searchable.
    const named = sessions.filter(s => s.label);
    const filtered = query ? named.filter(s => fuzzyMatch(query, s.label)) : named;
    const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.return) {
            const chosen = filtered[safeCursor];
            if (chosen)
                onSelect(chosen);
            return;
        }
        if (key.upArrow) {
            setCursor(c => Math.max(0, Math.min(c, filtered.length - 1) - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(filtered.length - 1, c + 1));
            return;
        }
        if (key.backspace || key.delete) {
            setQuery(q => q.slice(0, -1));
            setCursor(0);
            return;
        }
        if (input && !key.ctrl && !key.meta) {
            setQuery(q => q + input);
            setCursor(0);
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "Search sessions " }), _jsx(Text, { dimColor: true, children: "(by name)" })] }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { dimColor: true, children: "/ " }), _jsx(Text, { color: "cyan", children: query }), _jsx(Text, { dimColor: true, children: "\u2588" })] }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [named.length === 0 && (_jsx(Text, { dimColor: true, children: "No named sessions yet." })), named.length > 0 && filtered.length === 0 && (_jsx(Text, { dimColor: true, children: "No matches." })), filtered.map((s, i) => {
                        const isCursor = i === safeCursor;
                        const name = `${s.label} · ${s.projectName}`;
                        return (_jsxs(Box, { children: [_jsxs(Text, { color: isCursor ? 'cyan' : undefined, bold: isCursor, children: [isCursor ? '▸ ' : '  ', name] }), s.sshTarget && _jsx(Text, { dimColor: true, children: "  (remote)" })] }, s.paneId ?? String(s.pid)));
                    })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "  \u2191\u2193 navigate \u00B7 type to search \u00B7 Enter select \u00B7 Esc cancel" }) })] }));
}
//# sourceMappingURL=SessionSearch.js.map