import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useCallback } from 'react';
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
export function NewSession({ projects, hosts, onSelect, onCancel, getPastSessions, getPastSessionsByTarget, onDeleteSession }) {
    const [cursor, setCursor] = useState(0);
    const [filter, setFilter] = useState('');
    const [customPath, setCustomPath] = useState('');
    const [deletedIds, setDeletedIds] = useState(new Set());
    const [mode, setMode] = useState(() => {
        const hasRecent = getPastSessionsByTarget(undefined).length > 0;
        if (hasRecent)
            return 'recent';
        return hosts.length > 0 ? 'host' : 'list';
    });
    const [selectedHost, setSelectedHost] = useState(undefined);
    const [pendingPath, setPendingPath] = useState('');
    const [pastSessions, setPastSessions] = useState([]);
    const [listCursor, setListCursor] = useState(-1); // -1 = text input focused, 0+ = past session list
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
    const targetSessions = useMemo(() => {
        if (mode !== 'custom' && mode !== 'host-list')
            return [];
        return getPastSessionsByTarget(selectedHost?.ssh).filter(s => !deletedIds.has(s.sessionId));
    }, [mode, selectedHost, getPastSessionsByTarget, deletedIds]);
    const recentSessions = useMemo(() => getPastSessionsByTarget(undefined).filter(s => !deletedIds.has(s.sessionId)), [getPastSessionsByTarget, deletedIds]);
    const handlePathSelected = useCallback((projectPath) => {
        const past = getPastSessions(projectPath);
        if (past.length > 0) {
            setPendingPath(projectPath);
            setPastSessions(past);
            setMode('resume');
            setCursor(0);
        }
        else {
            onSelect(projectPath, selectedHost);
        }
    }, [getPastSessions, onSelect, selectedHost]);
    useInput((input, key) => {
        if (key.escape) {
            if (mode === 'resume') {
                setMode(selectedHost ? 'custom' : 'list');
                setCursor(0);
                return;
            }
            if (mode === 'custom') {
                setMode(selectedHost ? 'host-list' : 'list');
                setCustomPath('');
                setCursor(0);
                return;
            }
            if (mode === 'host-list') {
                setMode('host');
                setCursor(0);
                return;
            }
            if (mode === 'list' && filter) {
                setFilter('');
                setCursor(0);
                return;
            }
            if ((mode === 'list' || mode === 'host') && recentSessions.length > 0) {
                setMode('recent');
                setCursor(0);
                return;
            }
            onCancel();
            return;
        }
        if (mode === 'recent') {
            if (key.upArrow || input === 'k')
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || input === 'j')
                setCursor(c => Math.min(recentSessions.length - 1, c + 1));
            if (key.return && recentSessions[cursor]) {
                const s = recentSessions[cursor];
                onSelect(s.cwd, undefined, s.sessionId);
            }
            if (input === 'n') {
                setMode(hosts.length > 0 ? 'host' : 'list');
                setCursor(0);
            }
            if (input === 'd' && recentSessions[cursor]) {
                const id = recentSessions[cursor].sessionId;
                onDeleteSession(id);
                setDeletedIds(prev => new Set([...prev, id]));
                setCursor(c => Math.min(c, Math.max(0, recentSessions.length - 2)));
            }
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
                setMode(chosen?.host ? 'host-list' : 'list');
                setCursor(0);
                setListCursor(-1);
            }
            return;
        }
        if (mode === 'resume') {
            const total = pastSessions.length + 1;
            if (key.upArrow || input === 'k')
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || input === 'j')
                setCursor(c => Math.min(total - 1, c + 1));
            if (key.return) {
                if (cursor < pastSessions.length) {
                    onSelect(pendingPath, selectedHost, pastSessions[cursor].sessionId);
                }
                else {
                    onSelect(pendingPath, selectedHost);
                }
            }
            return;
        }
        if (mode === 'host-list') {
            if (key.upArrow || input === 'k')
                setCursor(c => Math.max(0, c - 1));
            if (key.downArrow || input === 'j')
                setCursor(c => Math.min(targetSessions.length, c + 1));
            if (key.return) {
                if (cursor === targetSessions.length) {
                    setMode('custom');
                    setCursor(0);
                }
                else if (targetSessions[cursor]) {
                    handlePathSelected(targetSessions[cursor].cwd);
                }
            }
            if (input === 'd' && targetSessions[cursor]) {
                const id = targetSessions[cursor].sessionId;
                onDeleteSession(id);
                setDeletedIds(prev => new Set([...prev, id]));
                setCursor(c => Math.min(c, Math.max(0, targetSessions.length - 2)));
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
                    handlePathSelected(filtered[cursor].path);
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
            // custom mode
            if (key.upArrow) {
                setListCursor(c => Math.max(-1, c - 1));
                return;
            }
            if (key.downArrow) {
                setListCursor(c => Math.min(targetSessions.length - 1, c + 1));
                return;
            }
            if (key.tab) {
                setCustomPath(selectedHost ? tabCompleteRemote(customPath, selectedHost) : tabComplete(customPath));
                setListCursor(-1);
                return;
            }
            if (key.return) {
                if (listCursor >= 0 && targetSessions[listCursor]) {
                    handlePathSelected(targetSessions[listCursor].cwd);
                }
                else if (customPath.trim()) {
                    const expanded = customPath.startsWith('~') ? customPath.replace('~', process.env['HOME'] ?? '') : customPath;
                    handlePathSelected(expanded.replace(/\/$/, ''));
                }
                return;
            }
            if (input === 'd' && listCursor >= 0 && targetSessions[listCursor]) {
                const id = targetSessions[listCursor].sessionId;
                onDeleteSession(id);
                setDeletedIds(prev => new Set([...prev, id]));
                setListCursor(c => Math.min(c, targetSessions.length - 2));
                return;
            }
            if (key.backspace || key.delete) {
                setCustomPath(p => p.slice(0, -1));
            }
            else if (input && !key.ctrl && !key.meta && !key.tab) {
                setCustomPath(p => p + input);
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "New Claude Session" }), mode === 'recent' ? (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, color: "cyan", children: "Recent Sessions" }), _jsx(Text, { children: " " }), recentSessions.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No past sessions" })) : (recentSessions.map((s, i) => {
                        const sel = i === cursor;
                        const label = s.cwd.split('/').pop() ?? s.cwd;
                        const summary = s.contextSummary ?? s.goalSummary;
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: sel ? '▸ ' : '  ' }), _jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: label }), _jsxs(Text, { dimColor: true, children: ["  ", s.cwd, "  \u00B7  ", formatAge(s.startedAt)] })] }), summary && sel && (_jsxs(Text, { dimColor: true, children: ["    ", summary.length > 72 ? summary.slice(0, 71) + '…' : summary] }))] }, s.sessionId));
                    })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter resume \u00B7 n new session \u00B7 d delete \u00B7 Esc cancel" })] })) : mode === 'host' ? (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "Select target host" }), _jsx(Text, { children: " " }), hostOptions.map((h, i) => (_jsx(Box, { children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', h.label] }) }, h.label))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc cancel" })] })) : mode === 'host-list' ? (_jsxs(_Fragment, { children: [_jsxs(Text, { dimColor: true, children: ["\u2301 ", selectedHost?.name, " (", selectedHost?.ssh, ")"] }), _jsx(Text, { children: " " }), targetSessions.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No past sessions" })) : (targetSessions.map((s, i) => {
                        const sel = i === cursor;
                        const label = s.cwd.split('/').pop() ?? s.cwd;
                        const summary = s.contextSummary ?? s.goalSummary;
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: sel ? '▸ ' : '  ' }), _jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: label }), _jsxs(Text, { dimColor: true, children: ["  ", s.cwd, "  \u00B7  ", formatAge(s.startedAt)] })] }), summary && sel && (_jsxs(Text, { dimColor: true, children: ["    ", summary.length > 72 ? summary.slice(0, 71) + '…' : summary] }))] }, s.sessionId));
                    })), _jsx(Box, { children: _jsxs(Text, { color: cursor === targetSessions.length ? 'cyan' : undefined, bold: cursor === targetSessions.length, children: [cursor === targetSessions.length ? '▸ ' : '  ', "Enter custom path..."] }) }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 d delete \u00B7 Esc back" })] })) : mode === 'list' ? (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Filter: " }), _jsx(Text, { color: "cyan", children: filter || '' }), filter ? _jsx(Text, { color: "gray", children: "\u258B" }) : _jsx(Text, { dimColor: true, children: " (type to filter)" })] }), _jsx(Text, { children: " " }), filtered.map((p, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: i === cursor ? 'cyan' : undefined, bold: i === cursor, children: [i === cursor ? '▸ ' : '  ', p.name] }), _jsxs(Text, { dimColor: true, children: [" ", p.path] })] }, p.path))), _jsx(Box, { children: _jsxs(Text, { color: cursor === filtered.length ? 'cyan' : undefined, bold: cursor === filtered.length, children: [cursor === filtered.length ? '▸ ' : '  ', "Enter custom path..."] }) }), filtered.length === 0 && projects.length > 0 && (_jsxs(Text, { dimColor: true, children: ["  No matches for \"", filter, "\""] })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 type to filter \u00B7 Enter select \u00B7 Esc cancel" })] })) : mode === 'resume' ? (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, color: "cyan", children: "Resume a past session?" }), _jsx(Text, { dimColor: true, children: pendingPath }), _jsx(Text, { children: " " }), pastSessions.map((s, i) => {
                        const summary = s.contextSummary ?? s.goalSummary ?? s.nextSteps;
                        const age = formatAge(s.startedAt);
                        const isSelected = i === cursor;
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: isSelected ? 'cyan' : undefined, bold: isSelected, children: isSelected ? '▸ ' : '  ' }), _jsx(Text, { color: isSelected ? 'cyan' : 'white', children: "Resume" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", age] })] }), summary && (_jsxs(Text, { dimColor: true, children: ["    ", summary.length > 80 ? summary.slice(0, 79) + '…' : summary] }))] }, s.sessionId));
                    }), _jsx(Box, { children: _jsxs(Text, { color: cursor === pastSessions.length ? 'cyan' : undefined, bold: cursor === pastSessions.length, children: [cursor === pastSessions.length ? '▸ ' : '  ', "Start fresh"] }) }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc back" })] })) : (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: listCursor >= 0, children: "Path: " }), _jsx(Text, { color: "cyan", children: customPath }), listCursor < 0 && _jsx(Text, { color: "gray", children: "\u258B" })] }), completions.length > 1 && listCursor < 0 && (_jsx(Box, { flexDirection: "column", children: completions.map(c => (_jsxs(Text, { dimColor: true, children: ["  ", c, "/"] }, c))) })), targetSessions.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2500\u2500\u2500 Recent \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" }), targetSessions.map((s, i) => {
                                const sel = i === listCursor;
                                const label = s.cwd.split('/').pop() ?? s.cwd;
                                const summary = s.contextSummary ?? s.goalSummary;
                                return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: sel ? '▸ ' : '  ' }), _jsx(Text, { color: sel ? 'cyan' : undefined, bold: sel, children: label }), _jsxs(Text, { dimColor: true, children: ["  ", s.cwd, "  \u00B7  ", formatAge(s.startedAt)] })] }), summary && sel && (_jsxs(Text, { dimColor: true, children: ["    ", summary.length > 72 ? summary.slice(0, 71) + '…' : summary] }))] }, s.sessionId));
                            })] })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "\u2191\u2193 navigate \u00B7 Tab complete \u00B7 Enter confirm \u00B7 d delete \u00B7 Esc back" })] }))] }));
}
//# sourceMappingURL=NewSession.js.map