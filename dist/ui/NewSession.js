import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
function fuzzyMatch(query, target) {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi])
            qi++;
    }
    return qi === q.length;
}
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
export function NewSession({ projects, hosts, onSelect, onCancel }) {
    const [cursor, setCursor] = useState(0);
    const [filter, setFilter] = useState('');
    const [customPath, setCustomPath] = useState('');
    const [mode, setMode] = useState(hosts.length > 0 ? 'host' : 'list');
    const [selectedHost, setSelectedHost] = useState(undefined);
    // Host options: "local" + configured remote hosts
    const hostOptions = [
        { label: 'local' },
        ...hosts.map(h => ({ label: `⌁ ${h.name} (${h.ssh})`, host: h })),
    ];
    const filtered = useMemo(() => {
        if (!filter)
            return projects;
        return projects.filter(p => fuzzyMatch(filter, p.name) || fuzzyMatch(filter, p.path));
    }, [projects, filter]);
    const completions = useMemo(() => {
        if (mode !== 'custom')
            return [];
        return selectedHost ? listCompletionsRemote(customPath, selectedHost) : listCompletions(customPath);
    }, [mode, customPath, selectedHost]);
    useInput((input, key) => {
        if (key.escape) {
            if (mode === 'custom') {
                setMode('list');
                setCustomPath('');
                return;
            }
            if (mode === 'list' && filter) {
                setFilter('');
                setCursor(0);
                return;
            }
            if (mode === 'list' && hosts.length > 0) {
                setMode('host');
                setCursor(0);
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
                setSelectedHost(hostOptions[cursor]?.host);
                setMode(hostOptions[cursor]?.host ? 'custom' : 'list');
                setCursor(0);
            }
            return;
        }
        if (mode === 'list') {
            if (key.upArrow || (input === 'k' && !filter))
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || (input === 'j' && !filter))
                setCursor(c => Math.min(filtered.length, c + 1));
            if (key.return) {
                if (cursor === filtered.length) {
                    setMode('custom');
                }
                else if (filtered[cursor]) {
                    onSelect(filtered[cursor].path, selectedHost);
                }
            }
            if (key.backspace || key.delete) {
                setFilter(f => f.slice(0, -1));
                setCursor(0);
            }
            else if (input && !key.ctrl && !key.meta && !key.return && !(input === 'j' && !filter) && !(input === 'k' && !filter)) {
                setFilter(f => f + input);
                setCursor(0);
            }
        }
        else {
            if (key.tab) {
                setCustomPath(selectedHost ? tabCompleteRemote(customPath, selectedHost) : tabComplete(customPath));
                return;
            }
            if (key.return && customPath.trim()) {
                const expanded = customPath.startsWith('~') ? customPath.replace('~', process.env['HOME'] ?? '') : customPath;
                onSelect(expanded.replace(/\/$/, ''), selectedHost);
            }
            if (key.backspace || key.delete) {
                setCustomPath(p => p.slice(0, -1));
            }
            else if (input && !key.ctrl && !key.meta && !key.tab) {
                setCustomPath(p => p + input);
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "New Claude Session" }), mode === 'host' ? (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "Select target host" }), _jsx(Text, { children: " " }), hostOptions.map((h, i) => (_jsx(Box, { children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', h.label] }) }, h.label))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc cancel" })] })) : mode === 'list' ? (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Filter: " }), _jsx(Text, { color: "cyan", children: filter || '' }), filter ? _jsx(Text, { color: "gray", children: "\u258B" }) : _jsx(Text, { dimColor: true, children: " (type to filter)" })] }), _jsx(Text, { children: " " }), filtered.map((p, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', p.name] }), _jsxs(Text, { dimColor: true, children: [" ", p.path] })] }, p.path))), _jsx(Box, { children: _jsxs(Text, { color: cursor === filtered.length ? 'cyan' : undefined, bold: cursor === filtered.length, children: [cursor === filtered.length ? '▸ ' : '  ', "Enter custom path..."] }) }), filtered.length === 0 && projects.length > 0 && (_jsxs(Text, { dimColor: true, children: ["  No matches for \"", filter, "\""] })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 type to filter \u00B7 Enter select \u00B7 Esc cancel" })] })) : (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { children: "Path: " }), _jsx(Text, { color: "cyan", children: customPath }), _jsx(Text, { color: "gray", children: "\u258B" })] }), completions.length > 1 && (_jsx(Box, { marginTop: 1, flexDirection: "column", children: completions.map(c => (_jsxs(Text, { dimColor: true, children: ["  ", c, "/"] }, c))) })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Tab complete \u00B7 Enter confirm \u00B7 Esc back" })] }))] }));
}
//# sourceMappingURL=NewSession.js.map