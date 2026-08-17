import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fuzzyMatch } from './fuzzy.js';
function remoteListDirs(host, dir) {
    try {
        const cmd = `ls -1 -d ${dir}/*/ 2>/dev/null | xargs -I{} basename {}`;
        const fullCmd = host.commandPrefix
            ? `${host.commandPrefix} sh -c '${cmd.replace(/'/g, "'\\''")}'`
            : cmd;
        const out = execFileSync('ssh', [host.ssh, fullCmd], { timeout: 5000 }).toString();
        return out.trim().split('\n').filter(Boolean).filter(n => !n.startsWith('.'));
    }
    catch { }
    return [];
}
function tabCompleteRemote(input, host) {
    if (!input)
        return input;
    const dir = input.endsWith('/') ? input.replace(/\/$/, '') : path.posix.dirname(input);
    const prefix = input.endsWith('/') ? '' : path.posix.basename(input);
    const entries = remoteListDirs(host, dir).filter(n => n.toLowerCase().startsWith(prefix.toLowerCase())).sort();
    if (entries.length === 1) {
        return `${dir}/${entries[0]}/`;
    }
    else if (entries.length > 1) {
        let common = entries[0];
        for (const e of entries) {
            let i = 0;
            while (i < common.length && i < e.length && common[i].toLowerCase() === e[i].toLowerCase())
                i++;
            common = common.slice(0, i);
        }
        if (common.length > prefix.length)
            return `${dir}/${common}`;
    }
    return input;
}
function listCompletionsRemote(input, host) {
    if (!input)
        return [];
    const dir = input.endsWith('/') ? input.replace(/\/$/, '') : path.posix.dirname(input);
    const prefix = input.endsWith('/') ? '' : path.posix.basename(input);
    return remoteListDirs(host, dir)
        .filter(n => n.toLowerCase().startsWith(prefix.toLowerCase()))
        .sort()
        .slice(0, 8);
}
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
export function NewSession({ hosts, onSelect, onCancel, getPastSessionsByTarget }) {
    const [cursor, setCursor] = useState(0);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState(() => hosts.length > 0 ? 'host' : 'pick');
    const [selectedHost, setSelectedHost] = useState(undefined);
    // Host options: "local" + configured remote hosts
    const hostOptions = [
        { label: 'local' },
        ...hosts.map(h => ({ label: `⌁ ${h.name} (${h.ssh})`, host: h })),
    ];
    const workspaces = useMemo(() => getPastSessionsByTarget(selectedHost?.ssh), [selectedHost, getPastSessionsByTarget]);
    const filtered = useMemo(() => {
        if (!query)
            return workspaces;
        return workspaces.filter(s => fuzzyMatch(query, s.cwd) || fuzzyMatch(query, path.basename(s.cwd)));
    }, [workspaces, query]);
    const showStartIn = isPathLike(query) && query.trim() !== '';
    const completions = useMemo(() => {
        if (!showStartIn)
            return [];
        return selectedHost ? listCompletionsRemote(query, selectedHost) : listCompletions(query);
    }, [showStartIn, query, selectedHost]);
    const rowCount = filtered.length + (showStartIn ? 1 : 0);
    const handlePathSelected = useCallback((projectPath) => {
        onSelect(projectPath, selectedHost);
    }, [onSelect, selectedHost]);
    useInput((input, key) => {
        if (key.escape) {
            if (mode === 'pick' && query) {
                setQuery('');
                setCursor(0);
                return;
            }
            if (mode === 'pick') {
                if (hosts.length > 0) {
                    setMode('host');
                    setCursor(0);
                    return;
                }
                onCancel();
                return;
            }
            onCancel();
            return;
        }
        if (mode === 'host') {
            if (key.upArrow || input === 'k')
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || input === 'j')
                setCursor(c => Math.min(hostOptions.length - 1, c + 1));
            if (key.return) {
                const chosen = hostOptions[cursor];
                setSelectedHost(chosen?.host);
                setMode('pick');
                setCursor(0);
            }
            return;
        }
        // pick mode
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
                setQuery(selectedHost ? tabCompleteRemote(query, selectedHost) : tabComplete(query));
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
                    handlePathSelected(filtered[idx].cwd);
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
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "New Claude Session" }), mode === 'host' ? (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "Select target host" }), _jsx(Text, { children: " " }), hostOptions.map((h, i) => (_jsx(Box, { children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', h.label] }) }, h.label))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc cancel" })] })) : (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Path or filter: " }), _jsx(Text, { color: "cyan", children: query || '' }), query ? _jsx(Text, { color: "gray", children: "\u258B" }) : _jsx(Text, { dimColor: true, children: " (type to filter or enter a path)" })] }), _jsx(Text, { children: " " }), showStartIn && (_jsxs(Box, { children: [_jsxs(Text, { color: cursor === 0 ? 'cyan' : undefined, bold: cursor === 0, children: [cursor === 0 ? '▸ ' : '  ', "Start in: ", expand(query)] }), _jsx(Text, { dimColor: true, children: "   (Tab complete)" })] })), completions.length > 1 && (_jsx(Box, { flexDirection: "column", children: completions.map(c => (_jsxs(Text, { dimColor: true, children: ["  ", c, "/"] }, c))) })), filtered.map((s, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: cursor === (showStartIn ? i + 1 : i) ? 'cyan' : undefined, bold: cursor === (showStartIn ? i + 1 : i), children: [cursor === (showStartIn ? i + 1 : i) ? '▸ ' : '  ', path.basename(s.cwd)] }), _jsxs(Text, { dimColor: true, children: [" ", s.cwd, "  \u00B7  ", formatAge(s.startedAt)] })] }, s.cwd))), filtered.length === 0 && !showStartIn && query && (_jsxs(Text, { dimColor: true, children: ["  No matches for \"", query, "\""] })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 type = filter or path (/,~,.) \u00B7 Tab complete \u00B7 Enter select \u00B7 Esc back/cancel" })] }))] }));
}
//# sourceMappingURL=NewSession.js.map