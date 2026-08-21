import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import { sessionIdentity } from '../core/session-store.js';
import { useSessionStore } from './hooks/useSessionStore.js';
import { tmux } from '../tmux/commands.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SessionSearch } from './SessionSearch.js';
import { ResumeSearch } from './ResumeSearch.js';
import { resolveHostBySsh } from './host-resolve.js';
import { NewSession } from './NewSession.js';
import { writeAndExit, emitReady } from '../picker/protocol.js';
export function App({ tower, pickerMode, outputPath }) {
    const { exit } = useApp();
    const { sessions, tmuxCount } = useSessionStore(tower.store);
    const [view, setView] = useState('dashboard');
    const [selectedSession, setSelectedSession] = useState(null);
    const CURSOR_FILE = join(homedir(), '.config', 'popmux', 'picker-cursor');
    const [cursorIdentity, setCursorIdentity] = useState(() => {
        if (!pickerMode)
            return null;
        try {
            return readFileSync(CURSOR_FILE, 'utf8').trim() || null;
        }
        catch {
            return null;
        }
    });
    useEffect(() => {
        if (!pickerMode || !cursorIdentity)
            return;
        try {
            writeFileSync(CURSOR_FILE, cursorIdentity, 'utf8');
        }
        catch { /* ignore */ }
    }, [pickerMode, cursorIdentity]);
    // F12 sends \x1b[24~ — not caught by Ink's useInput (which only handles printable keys).
    // When in pickerMode (popup), F12 should close the popup the same as 'q'.
    useEffect(() => {
        if (!pickerMode)
            return;
        const onData = (data) => {
            if (data.toString() === '\x1b[24~')
                exit();
        };
        process.stdin.on('data', onData);
        return () => { process.stdin.off('data', onData); };
    }, [pickerMode, exit]);
    const handleSelect = useCallback((session) => {
        if (pickerMode && outputPath) {
            // Enter = "go" — switch to that session. This performs the same
            // "entering the session" action as handleGo's 'g' binding, so it must
            // clear the attention banner the same way — before writeAndExit's
            // process.exit(0), synchronously flushed (see handleGo for why).
            if (session.paneId) {
                tower.store.update(sessionIdentity(session), { needsAttention: false });
                tower.store.persistSync();
            }
            writeAndExit(outputPath, {
                action: 'go',
                sessionId: session.sessionId,
                paneId: session.paneId ?? '',
                host: session.host ?? 'local',
                cwd: session.cwd,
                sshTarget: session.sshTarget ?? null,
                agentId: 'claude',
            });
        }
        setSelectedSession(session);
        setView('detail');
    }, [pickerMode, outputPath, tower]);
    const handleOpenSearch = useCallback(() => {
        setView('search');
    }, []);
    // Resume picker scan state: `scanGen` bumps on scan completion to refresh the
    // open overlay (its useMemo deps on generation); `resumeScanning` drives the
    // "scanning…" footer on the first cold scan only.
    const [scanGen, setScanGen] = useState(0);
    const [resumeScanning, setResumeScanning] = useState(false);
    const handleOpenResumeSearch = useCallback(() => {
        setView('resume-search');
        if (!tower.scanner.isScanned())
            setResumeScanning(true);
        // Always ensure (incremental re-scan of changed dirs is cheap); refresh the
        // overlay when it resolves.
        void tower.scanner.ensureScanned().then(() => {
            setResumeScanning(false);
            setScanGen(g => g + 1);
        });
    }, [tower]);
    // Search selection moves the dashboard cursor to the chosen session — it does
    // NOT navigate (that stays on the `g` key). Works in both normal and picker
    // mode: cursorIdentity is the controlled cursor for the underlying dashboard.
    const handleSearchSelect = useCallback((session) => {
        setCursorIdentity(session.paneId ?? String(session.pid));
        setView('dashboard');
    }, []);
    const handleBack = useCallback(() => {
        setView('dashboard');
        setSelectedSession(null);
    }, []);
    const handleSwapFavoriteOrder = useCallback((idA, idB) => {
        const all = tower.store.getAll();
        const a = all.find(s => s.sessionId === idA);
        const b = all.find(s => s.sessionId === idB);
        if (!a || !b)
            return;
        const identityA = a.paneId ?? String(a.pid);
        const identityB = b.paneId ?? String(b.pid);
        tower.store.update(identityA, { favoritedAt: b.favoritedAt });
        tower.store.update(identityB, { favoritedAt: a.favoritedAt });
        tower.store.persistSync();
    }, [tower]);
    const handleToggleFavorite = useCallback((session) => {
        const nowFav = !session.favorite;
        const identity = session.paneId ?? String(session.pid);
        tower.store.update(identity, { favorite: nowFav, favoritedAt: nowFav ? Date.now() : undefined });
        tower.store.persistSync();
    }, [tower]);
    const handleRefresh = useCallback((session) => {
        void tower.refreshSession(session.sessionId);
    }, [tower]);
    const handleKill = useCallback(async (session) => {
        if (pickerMode && outputPath) {
            // Picker doesn't kill — treat 'x' as cancel (no destructive action via tmpfile).
            writeAndExit(outputPath, { action: 'cancel' });
        }
        if (!session.pid)
            return;
        // Remove from favorites on kill
        if (session.favorite) {
            const identity = session.paneId ?? String(session.pid);
            tower.store.update(identity, { favorite: false, favoritedAt: undefined });
        }
        try {
            if (session.sshTarget) {
                const hostConfig = tower.config.hosts.find(h => h.ssh === session.sshTarget);
                const killCmd = `kill ${session.pid}`;
                const cmd = hostConfig?.command_prefix
                    ? `${hostConfig.command_prefix} sh -c '${killCmd}'`
                    : killCmd;
                const { spawn: sp } = await import('node:child_process');
                sp('ssh', [session.sshTarget, cmd], { stdio: 'ignore', detached: true });
            }
            else {
                process.kill(session.pid, 'SIGTERM');
            }
        }
        catch { }
    }, [tower]);
    const handleGo = useCallback(async (session) => {
        // Clear the attention banner before any exit/switch branch below — picker
        // mode's writeAndExit calls process.exit(0), so this must run first and
        // flush synchronously or the clear is lost.
        if (session.paneId) {
            tower.store.update(sessionIdentity(session), { needsAttention: false });
            tower.store.persistSync();
        }
        if (pickerMode && outputPath) {
            writeAndExit(outputPath, {
                action: 'go',
                sessionId: session.sessionId,
                paneId: session.paneId ?? '',
                host: session.host ?? 'local',
                cwd: session.cwd,
                sshTarget: session.sshTarget ?? null,
                agentId: 'claude',
            });
        }
        if (!session.paneId)
            return;
        const { execa: ex } = await import('execa');
        const tmuxKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;
        if (session.sshTarget) {
            // Remote: full-screen popup — tmux commands run on SSH host, NOT inside commandPrefix container
            const paneSelect = `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index}' | grep '^${session.paneId} ' | head -1`;
            const resumeSessionName = `claude-${session.projectName}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            const claudeResumeCmd = session.sessionId ? `claude --resume ${session.sessionId}` : 'claude';
            const restartCmd = `tmux new-session -d -s ${resumeSessionName} -c ${session.cwd} '${claudeResumeCmd}' 2>/dev/null || true; ` +
                `tmux bind-key -T root ${tmuxKey} detach-client && ` +
                `TMUX= tmux attach -t ${resumeSessionName}; ` +
                `tmux unbind-key -T root ${tmuxKey}`;
            const setupCmd = `PINFO=\\$(${paneSelect}); ` +
                `if [ -z "\\$PINFO" ]; then ${restartCmd}; else ` +
                `SESS=\\$(echo \\$PINFO | awk '{print \\$2}'); WIDX=\\$(echo \\$PINFO | awk '{print \\$3}'); ` +
                `GO=_popmux_go_\\$\\$; tmux kill-session -t \\$GO 2>/dev/null; ` +
                `tmux new-session -d -s \\$GO -t \\$SESS && ` +
                `tmux set-option -t \\$GO window-size largest 2>/dev/null; ` +
                `tmux bind-key -T root ${tmuxKey} detach-client && ` +
                `TMUX= tmux attach -t \\$GO \\\\; select-window -t :\\$WIDX; ` +
                `tmux unbind-key -T root ${tmuxKey}; tmux kill-session -t \\$GO 2>/dev/null; fi`;
            await tmux.displayPopup({
                width: '100%',
                height: '100%',
                title: ` ⌁ ${session.host}:${session.projectName} | ${tmuxKey} to close `,
                command: `ssh -t -o LogLevel=ERROR ${session.sshTarget} "${setupCmd}"`,
                closeOnExit: true,
            });
        }
        else {
            // Local: switch-client to target session/window
            try {
                const { stdout: homeInfo } = await ex('tmux', ['display-message', '-p', '#{session_name}:#{window_index}']);
                const [homeSession, homeWindow] = homeInfo.trim().split(':');
                const { stdout: targetInfo } = await ex('tmux', ['display-message', '-t', session.paneId, '-p', '#{session_name}:#{window_index}']);
                const [targetSession, targetWindow] = targetInfo.trim().split(':');
                // Bind close key in root table: switch back + auto-unbind (preserves custom shortcuts)
                await ex('tmux', ['bind-key', '-T', 'root', tmuxKey,
                    'switch-client', '-t', `${homeSession}:${homeWindow}`,
                    ';', 'unbind-key', '-T', 'root', tmuxKey,
                ]);
                // Switch to target
                await ex('tmux', ['switch-client', '-t', `${targetSession}:${targetWindow}`]);
            }
            catch {
                // Pane is gone — restart in __popmux_playground with --resume
                const resumeArg = session.sessionId ? ` --resume ${session.sessionId}` : '';
                const claudeArgs = (tower.config.claude_args ? ` ${tower.config.claude_args}` : '') + resumeArg;
                const hiveSession = '__popmux_playground';
                const windowName = session.projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
                try {
                    let sessionExists = false;
                    try {
                        await ex('tmux', ['has-session', '-t', hiveSession]);
                        sessionExists = true;
                    }
                    catch { }
                    const args = sessionExists
                        ? ['new-window', '-t', hiveSession, '-n', windowName, '-c', session.cwd, '-P', '-F', '#{window_index}', `claude${claudeArgs}`]
                        : ['new-session', '-d', '-s', hiveSession, '-n', windowName, '-c', session.cwd, '-P', '-F', '#{window_index}', `claude${claudeArgs}`];
                    const { stdout: windowIndex } = await ex('tmux', args);
                    const { stdout: homeInfo } = await ex('tmux', ['display-message', '-p', '#{session_name}:#{window_index}']);
                    const [homeSession, homeWindow] = homeInfo.trim().split(':');
                    await ex('tmux', ['bind-key', '-T', 'root', tmuxKey,
                        'switch-client', '-t', `${homeSession}:${homeWindow}`,
                        ';', 'unbind-key', '-T', 'root', tmuxKey,
                    ]);
                    await ex('tmux', ['switch-client', '-t', `${hiveSession}:${windowIndex.trim()}`]);
                }
                catch { }
            }
        }
    }, [tower]);
    const handleOpenNewSession = useCallback(() => {
        setView('new-session');
    }, []);
    const getPastSessionsByTarget = useCallback((sshTarget) => {
        return tower.store.getPastSessionsByTarget(sshTarget);
    }, [tower]);
    const handleNewSession = useCallback(async (projectPath, host, resumeSessionId) => {
        if (pickerMode && outputPath) {
            writeAndExit(outputPath, {
                action: 'new',
                cwd: projectPath,
                host: host?.name ?? 'local',
                sshTarget: host?.ssh ?? null,
                agentId: 'claude',
                resumeSessionId: resumeSessionId ?? null,
            });
        }
        const closeKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;
        const name = projectPath.split('/').pop() ?? projectPath;
        const resumeArg = resumeSessionId ? ` --resume ${resumeSessionId}` : '';
        const claudeArgs = (tower.config.claude_args ? ` ${tower.config.claude_args}` : '') + resumeArg;
        setView('dashboard');
        const { execa: ex } = await import('execa');
        if (host) {
            // Remote: SSH + tmux new-session in separate session
            const sessionName = `claude-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            const claudeCmd = host.commandPrefix
                ? `${host.commandPrefix} sh -c 'cd ${projectPath} && claude${claudeArgs}'`
                : `cd ${projectPath} && claude${claudeArgs}`;
            const sshCmd = `ssh -t ${host.ssh} "tmux new-session -d -s ${sessionName} -c ${projectPath} '${claudeCmd.replace(/'/g, "'\\''")}'"`;
            try {
                await ex('sh', ['-c', sshCmd], { timeout: 10000 });
                await tmux.displayPopup({
                    width: '80%',
                    height: '80%',
                    title: ` ⌁ ${host.name}:${name} (new) | ${closeKey} to close `,
                    command: `tmux bind-key -T popmux-nav ${closeKey} detach-client && ssh -t ${host.ssh} "tmux attach -t ${sessionName}" ; tmux unbind-key -T popmux-nav ${closeKey}`,
                    closeOnExit: true,
                });
            }
            catch { }
        }
        else {
            // Local: add a window to the hive session (create hive if needed)
            const hiveSession = '__popmux_playground';
            const windowName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
            try {
                let sessionExists = false;
                try {
                    await ex('tmux', ['has-session', '-t', hiveSession]);
                    sessionExists = true;
                }
                catch { }
                let windowIndex;
                if (!sessionExists) {
                    const { stdout } = await ex('tmux', [
                        'new-session', '-d', '-s', hiveSession, '-n', windowName, '-c', projectPath,
                        '-P', '-F', '#{window_index}', `claude${claudeArgs}`,
                    ]);
                    windowIndex = stdout.trim();
                }
                else {
                    const { stdout } = await ex('tmux', [
                        'new-window', '-t', hiveSession, '-n', windowName, '-c', projectPath,
                        '-P', '-F', '#{window_index}', `claude${claudeArgs}`,
                    ]);
                    windowIndex = stdout.trim();
                }
                // Window created — session will be discovered by Tower automatically
            }
            catch { }
        }
    }, [tower]);
    // Resurrect a dead/past session: launch a new tmux session running
    // `claude --resume <id>` via the existing handleNewSession path.
    const handleResumeSelect = useCallback(async (past) => {
        const host = resolveHostBySsh(tower.config.hosts, past.sshTarget);
        if (past.sshTarget && !host) {
            // Remote host no longer configured — silent no-op (no toast infra; B4).
            setView('dashboard');
            return;
        }
        setView('dashboard');
        await handleNewSession(past.cwd, host, past.sessionId);
    }, [tower, handleNewSession]);
    const handleQuit = useCallback(async () => {
        if (pickerMode && outputPath) {
            writeAndExit(outputPath, { action: 'cancel' });
        }
        await tower.stop();
        // Kill the entire popmux tmux session so all outer wrapper processes exit cleanly
        if (process.env['TMUX']) {
            try {
                const { execSync } = await import('node:child_process');
                execSync('tmux kill-session -t claude-popmux 2>/dev/null', { timeout: 2000 });
            }
            catch { }
        }
        exit();
    }, [tower, exit]);
    const { stdout } = useStdout();
    const [termSize, setTermSize] = useState({
        width: stdout?.columns ?? 80,
        height: stdout?.rows ?? 24,
    });
    useEffect(() => {
        const onResize = () => {
            setTermSize({
                width: stdout?.columns ?? 80,
                height: stdout?.rows ?? 24,
            });
        };
        process.stdout.on('resize', onResize);
        return () => { process.stdout.off('resize', onResize); };
    }, [stdout]);
    // Picker SLO: emit READY <ms> on stderr after first render
    useEffect(() => {
        if (pickerMode)
            emitReady();
    }, [pickerMode]);
    const termWidth = termSize.width;
    const termHeight = termSize.height;
    const MIN_WIDTH = 60;
    const MIN_HEIGHT = 15;
    // Too small to render
    if (termWidth < MIN_WIDTH || termHeight < MIN_HEIGHT) {
        return (_jsx(Box, { width: termWidth, height: termHeight, alignItems: "center", justifyContent: "center", children: _jsxs(Text, { color: "yellow", children: ["Terminal too small (", termWidth, "x", termHeight, "). Need at least ", MIN_WIDTH, "x", MIN_HEIGHT, "."] }) }));
    }
    // Fullscreen layout: the popup is sized to (near) the whole terminal now, so
    // a centered, width-capped bordered box is both wasted space and a source of
    // resize glitches (Dashboard's scroll math didn't know how many rows the
    // header/border/padding ate, so it could compute more content than actually
    // fit on-screen — the terminal itself would then scroll mid-frame, leaving
    // stale/overlapping text). Use the full width/height directly, no border.
    const contentPaddingX = 3;
    // Rows the header block above Dashboard occupies, so Dashboard's viewport
    // math can account for the real remaining height (not just termHeight).
    const bigLogo = view === 'dashboard' && termHeight >= 30;
    const compactLogo = view === 'dashboard' && termHeight >= 20 && termHeight < 30;
    const LOGO_MARGIN_TOP = 1; // small gap so the logo isn't flush against the screen's top edge
    const headerHeight = bigLogo ? 7 : compactLogo ? 3 : 0; // logo/compact rows + top gap + 1 spacer row
    return (_jsxs(Box, { width: termWidth, height: termHeight, flexDirection: "column", children: [bigLogo && (_jsxs(Box, { justifyContent: "flex-start", alignItems: "flex-end", marginTop: LOGO_MARGIN_TOP, marginBottom: 1, paddingX: contentPaddingX, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "cyan", children: ' ██████╗  ██████╗ ████████╗' }), _jsx(Text, { color: "cyan", children: '██╔════╝ ██╔════╝ ╚══██╔══╝' }), _jsx(Text, { color: "cyan", children: '██║      ██║         ██║' }), _jsx(Text, { color: "cyan", children: '╚██████╗ ╚██████╗    ██║' }), _jsx(Text, { color: "cyan", children: ' ╚═════╝  ╚═════╝    ╚═╝' })] }), _jsxs(Box, { flexDirection: "column", justifyContent: "flex-end", marginLeft: 2, children: [_jsxs(Text, { dimColor: true, children: ["v", APP_VERSION] }), _jsxs(Text, { dimColor: true, children: [sessions.length, " sessions"] })] })] })), compactLogo && (_jsxs(Box, { justifyContent: "flex-start", alignItems: "center", marginTop: LOGO_MARGIN_TOP, marginBottom: 1, paddingX: contentPaddingX, children: [_jsx(Text, { color: "cyan", bold: true, children: "\u25C6 CCT" }), _jsxs(Text, { dimColor: true, children: [" v", APP_VERSION] }), _jsxs(Text, { dimColor: true, children: ["  ", sessions.length, " sessions"] })] })), _jsxs(Box, { flexDirection: "column", paddingX: contentPaddingX, width: termWidth, children: [view === 'dashboard' && (_jsx(Dashboard, { sessions: sessions, tmuxCount: tmuxCount, termWidth: termWidth, termHeight: termHeight, headerHeight: headerHeight, maxTaskWidth: Math.max(20, termWidth - 2 * contentPaddingX - 16), cursorIdentity: cursorIdentity, onCursorChange: setCursorIdentity, onSwapFavoriteOrder: handleSwapFavoriteOrder, onSelect: handleSelect, onOpenSearch: handleOpenSearch, onOpenResumeSearch: handleOpenResumeSearch, onToggleFavorite: handleToggleFavorite, onRefresh: handleRefresh, onKill: handleKill, onGo: handleGo, onNewSession: handleOpenNewSession, onQuit: handleQuit, pickerMode: pickerMode, initialDisplayOrder: tower.store.displayOrder, onDisplayOrderChange: (order) => { tower.store.displayOrder = order; } })), view === 'new-session' && (_jsx(NewSession, { hosts: tower.config.hosts.map(h => ({ name: h.name, ssh: h.ssh, commandPrefix: h.command_prefix })), onSelect: handleNewSession, onCancel: () => {
                            if (pickerMode && outputPath) {
                                writeAndExit(outputPath, { action: 'cancel' });
                            }
                            setView('dashboard');
                        }, getPastSessionsByTarget: getPastSessionsByTarget })), view === 'detail' && selectedSession && (_jsx(DetailView, { session: selectedSession, onBack: handleBack })), view === 'search' && (_jsx(SessionSearch, { sessions: sessions, onSelect: handleSearchSelect, onCancel: () => setView('dashboard') })), view === 'resume-search' && (_jsx(ResumeSearch, { getSessions: () => {
                            // All resumable sessions on disk (~/.claude/projects) merged with
                            // state.json metadata — not just the few popmux tracked live.
                            const all = tower.store.getAllResumableSessions(tower.scanner.getCached(), tower.scanner.isScanned());
                            // Picker mode can't resurrect remote sessions (popmux spawn remote
                            // is a B4 stub), so hide them where they'd dead-end.
                            return pickerMode ? all.filter(s => !s.sshTarget) : all;
                        }, generation: scanGen, scanning: resumeScanning, onSelect: handleResumeSelect, onCancel: () => setView('dashboard'), termHeight: termHeight }))] })] }));
}
//# sourceMappingURL=App.js.map