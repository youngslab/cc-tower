import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import { useSessionStore } from './hooks/useSessionStore.js';
import { useTmux } from './hooks/useTmux.js';
import { tmux } from '../tmux/commands.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SendInput } from './SendInput.js';
import { NewSession } from './NewSession.js';
import { getRecentProjects } from '../utils/recent-projects.js';
import { writeAndExit, emitReady } from '../picker/protocol.js';
export function App({ tower, pickerMode, outputPath }) {
    const { exit } = useApp();
    const { sessions, tmuxCount } = useSessionStore(tower.store);
    const { send } = useTmux(tower.config.keys.close);
    const [view, setView] = useState('dashboard');
    const [selectedSession, setSelectedSession] = useState(null);
    const [recentProjects, setRecentProjects] = useState([]);
    const [cursorIdentity, setCursorIdentity] = useState(null);
    const handleSelect = useCallback((session) => {
        if (pickerMode && outputPath) {
            // Enter = "go" — switch to that session
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
    }, [pickerMode, outputPath]);
    const handleSend = useCallback((session) => {
        // In picker mode, route through the local SendInput so the user can type a
        // message inline; only emit JSON once they submit. (Empty text = cancel.)
        setSelectedSession(session);
        setView('send');
    }, []);
    const handleSendText = useCallback(async (text) => {
        if (pickerMode && outputPath && selectedSession) {
            writeAndExit(outputPath, {
                action: 'send',
                sessionId: selectedSession.sessionId,
                paneId: selectedSession.paneId ?? '',
                host: selectedSession.host ?? 'local',
                sshTarget: selectedSession.sshTarget ?? null,
                agentId: 'claude',
                text,
            });
        }
        if (selectedSession) {
            await send(selectedSession, text);
        }
        setView(view === 'send' ? 'dashboard' : 'detail');
    }, [selectedSession, send, view, pickerMode, outputPath]);
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
    }, [tower]);
    const handleToggleFavorite = useCallback((session) => {
        const nowFav = !session.favorite;
        const identity = session.paneId ?? String(session.pid);
        tower.store.update(identity, { favorite: nowFav, favoritedAt: nowFav ? Date.now() : undefined });
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
        const activePaths = new Set(sessions.map(s => s.cwd).filter(Boolean));
        const projects = getRecentProjects(15).filter(p => !activePaths.has(p.path));
        setRecentProjects(projects);
        setView('new-session');
    }, [sessions]);
    const getPastSessions = useCallback((cwd) => {
        return tower.store.getPastSessionsByCwd(cwd);
    }, [tower]);
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
    // Dynamic sizing: use 70% of terminal width
    const boxWidth = Math.max(MIN_WIDTH, Math.min(termWidth - 4, Math.floor(termWidth * 0.7)));
    return (_jsxs(Box, { width: termWidth, height: termHeight, flexDirection: "column", alignItems: "center", justifyContent: "center", children: [view === 'dashboard' && termHeight >= 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "flex-end", marginBottom: 0, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "cyan", children: ' ██████╗  ██████╗ ████████╗' }), _jsx(Text, { color: "cyan", children: '██╔════╝ ██╔════╝ ╚══██╔══╝' }), _jsx(Text, { color: "cyan", children: '██║      ██║         ██║' }), _jsx(Text, { color: "cyan", children: '╚██████╗ ╚██████╗    ██║' }), _jsx(Text, { color: "cyan", children: ' ╚═════╝  ╚═════╝    ╚═╝' })] }), _jsxs(Box, { flexDirection: "column", justifyContent: "flex-end", marginLeft: 2, children: [_jsxs(Text, { dimColor: true, children: ["v", APP_VERSION] }), _jsxs(Text, { dimColor: true, children: [sessions.length, " sessions"] })] })] })), view === 'dashboard' && termHeight >= 20 && termHeight < 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "center", marginBottom: 0, children: [_jsx(Text, { color: "cyan", bold: true, children: "\u25C6 CCT" }), _jsxs(Text, { dimColor: true, children: [" v", APP_VERSION] }), _jsxs(Text, { dimColor: true, children: ["  ", sessions.length, " sessions"] })] })), _jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 2, paddingY: 1, width: boxWidth, children: [view === 'dashboard' && (_jsx(Dashboard, { sessions: sessions, tmuxCount: tmuxCount, maxTaskWidth: Math.max(10, boxWidth - 43), cursorIdentity: cursorIdentity, onCursorChange: setCursorIdentity, onSwapFavoriteOrder: handleSwapFavoriteOrder, onSelect: handleSelect, onSend: handleSend, onToggleFavorite: handleToggleFavorite, onRefresh: handleRefresh, onKill: handleKill, onGo: handleGo, onNewSession: handleOpenNewSession, onQuit: handleQuit, initialDisplayOrder: tower.store.displayOrder, onDisplayOrderChange: (order) => { tower.store.displayOrder = order; } })), view === 'new-session' && (_jsx(NewSession, { projects: recentProjects, hosts: tower.config.hosts.map(h => ({ name: h.name, ssh: h.ssh, commandPrefix: h.command_prefix })), onSelect: handleNewSession, onCancel: () => {
                            if (pickerMode && outputPath) {
                                writeAndExit(outputPath, { action: 'cancel' });
                            }
                            setView('dashboard');
                        }, getPastSessions: getPastSessions, getPastSessionsByTarget: getPastSessionsByTarget, getAllPastSessions: () => tower.store.getAllPastSessions(), onDeleteSession: (id) => tower.store.deletePersistedSession(id) })), view === 'detail' && selectedSession && (_jsx(DetailView, { session: selectedSession, onBack: handleBack, onSend: handleSend })), view === 'send' && selectedSession && (_jsx(SendInput, { session: selectedSession, confirmWhenBusy: tower.config.commands.confirm_when_busy, onSend: handleSendText, onCancel: () => {
                            if (pickerMode && outputPath) {
                                writeAndExit(outputPath, { action: 'cancel' });
                            }
                            setView('dashboard');
                        } }))] })] }));
}
//# sourceMappingURL=App.js.map