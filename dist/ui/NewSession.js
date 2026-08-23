import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { fuzzyMatch } from './fuzzy.js';
import { agentLabel, agentShortBadge, normalizeAgentId } from '../agents/types.js';
function tabComplete(input) {
    if (!input)
        return input;
    const expanded = input.startsWith('~') ? input.replace('~', process.env['HOME'] ?? '') : input;
    const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
    const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .sort();
        if (entries.length === 1) {
            return path.join(dir, entries[0].name) + '/';
        }
        else if (entries.length > 1) {
            // Find common prefix
            let common = entries[0].name;
            for (const e of entries) {
                let i = 0;
                while (i < common.length && i < e.name.length && common[i].toLowerCase() === e.name[i].toLowerCase())
                    i++;
                common = common.slice(0, i);
            }
            if (common.length > prefix.length) {
                return path.join(dir, common);
            }
        }
    }
    catch { }
    return input;
}
function listCompletions(input) {
    if (!input)
        return [];
    const expanded = input.startsWith('~') ? input.replace('~', process.env['HOME'] ?? '') : input;
    const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
    const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .map(e => e.name)
            .sort()
            .slice(0, 8);
    }
    catch { }
    return [];
}
function formatAge(ts) {
    const diff = Date.now() - ts;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (d > 0)
        return `${d}d ago`;
    if (h > 0)
        return `${h}h ago`;
    return 'recently';
}
function isPathLike(q) {
    return /^[/~.]/.test(q);
}
function expand(q) {
    return q.startsWith('~') ? q.replace('~', process.env['HOME'] ?? '') : q;
}
function pastSessionIdentity(s) {
    return `${normalizeAgentId(s.agentId)}::${s.sessionId || s.cwd}`;
}
export function NewSession({ onSelect, onCancel, getPastSessionsByTarget }) {
    const [cursor, setCursor] = useState(0);
    const [query, setQuery] = useState('');
    const [selectedAgent, setSelectedAgent] = useState('claude');
    const workspaces = useMemo(() => getPastSessionsByTarget(undefined), [getPastSessionsByTarget]);
    const filtered = useMemo(() => {
        if (!query)
            return workspaces;
        return workspaces.filter(s => fuzzyMatch(query, s.cwd) || fuzzyMatch(query, path.basename(s.cwd)));
    }, [workspaces, query]);
    const showStartIn = isPathLike(query) && query.trim() !== '';
    const completions = useMemo(() => {
        if (!showStartIn)
            return [];
        return listCompletions(query);
    }, [showStartIn, query]);
    const rowCount = filtered.length + (showStartIn ? 1 : 0);
    const handlePathSelected = useCallback((projectPath) => {
        onSelect(projectPath, undefined, undefined, selectedAgent);
    }, [onSelect, selectedAgent]);
    const handlePastSessionSelected = useCallback((past) => {
        onSelect(past.cwd, undefined, undefined, normalizeAgentId(past.agentId));
    }, [onSelect]);
    useInput((input, key) => {
        if (key.escape) {
            if (query) {
                setQuery('');
                setCursor(0);
                return;
            }
            onCancel();
            return;
        }
        if (input === 'a') {
            setSelectedAgent(a => a === 'claude' ? 'codex' : 'claude');
            return;
        }
        if (key.upArrow) {
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(rowCount - 1, c + 1));
            return;
        }
        if (key.tab) {
            if (showStartIn) {
                setQuery(tabComplete(query));
            }
            return;
        }
        if (key.return) {
            if (showStartIn && cursor === 0) {
                handlePathSelected(expand(query).replace(/\/$/, ''));
            }
            else {
                const idx = showStartIn ? cursor - 1 : cursor;
                if (filtered[idx])
                    handlePastSessionSelected(filtered[idx]);
            }
            return;
        }
        if (key.backspace || key.delete) {
            setQuery(q => q.slice(0, -1));
            setCursor(0);
            return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab && !key.return) {
            setQuery(q => q + input);
            setCursor(0);
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "New AI Session" }), _jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Path or filter: " }), _jsx(Text, { color: "cyan", children: query || '' }), query ? _jsx(Text, { color: "gray", children: "\u258B" }) : _jsx(Text, { dimColor: true, children: " (type to filter or enter a path)" })] }), _jsxs(Text, { dimColor: true, children: ["Agent: ", agentLabel(selectedAgent), " \u00B7 press a to toggle"] }), _jsx(Text, { children: " " }), showStartIn && (_jsxs(Box, { children: [_jsxs(Text, { color: cursor === 0 ? 'cyan' : undefined, bold: cursor === 0, children: [cursor === 0 ? '▸ ' : '  ', "Start in: ", expand(query)] }), _jsx(Text, { dimColor: true, children: "   (Tab complete)" })] })), completions.length > 1 && (_jsx(Box, { flexDirection: "column", children: completions.map(c => (_jsxs(Text, { dimColor: true, children: ["  ", c, "/"] }, c))) })), filtered.map((s, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: cursor === (showStartIn ? i + 1 : i) ? 'cyan' : undefined, bold: cursor === (showStartIn ? i + 1 : i), children: [cursor === (showStartIn ? i + 1 : i) ? '▸ ' : '  ', agentShortBadge(normalizeAgentId(s.agentId)), " ", path.basename(s.cwd)] }), _jsxs(Text, { dimColor: true, children: [" ", s.cwd, "  \u00B7  ", formatAge(s.startedAt)] })] }, pastSessionIdentity(s)))), filtered.length === 0 && !showStartIn && query && (_jsxs(Text, { dimColor: true, children: ["  No matches for \"", query, "\""] })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 a toggle agent \u00B7 type = filter or path (/,~,.) \u00B7 Tab complete \u00B7 Enter select \u00B7 Esc cancel" })] })] }));
}
//# sourceMappingURL=NewSession.js.map