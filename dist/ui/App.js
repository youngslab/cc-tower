import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { useSessionStore } from './hooks/useSessionStore.js';
import { useTmux } from './hooks/useTmux.js';
import { tmux } from '../tmux/commands.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SendInput } from './SendInput.js';
import { NewSession } from './NewSession.js';
import { getRecentProjects } from '../utils/recent-projects.js';
export function App({ tower }) {
    const { exit } = useApp();
    const { sessions, tmuxCount } = useSessionStore(tower.store);
    const { send, peek } = useTmux(tower.config.keys.close);
    const [view, setView] = useState('dashboard');
    const [selectedSession, setSelectedSession] = useState(null);
    const [recentProjects, setRecentProjects] = useState([]);
    const handleSelect = useCallback((session) => {
        setSelectedSession(session);
        setView('detail');
    }, []);
    const handleSend = useCallback((session) => {
        setSelectedSession(session);
        setView('send');
    }, []);
    const handlePeek = useCallback(async (session) => {
        if (!session.hasTmux && !session.sshTarget)
            return;
        await peek(session);
    }, [peek]);
    const handleSendText = useCallback(async (text) => {
        if (selectedSession) {
            await send(selectedSession, text);
        }
        setView(view === 'send' ? 'dashboard' : 'detail');
    }, [selectedSession, send, view]);
    const handleBack = useCallback(() => {
        setView('dashboard');
        setSelectedSession(null);
    }, []);
    const handleToggleFavorite = useCallback((session) => {
        const nowFav = !session.favorite;
        tower.store.update(session.sessionId, { favorite: nowFav, favoritedAt: nowFav ? Date.now() : undefined });
    }, [tower]);
    const handleRefresh = useCallback((session) => {
        void tower.refreshSession(session.sessionId);
    }, [tower]);
    const handleKill = useCallback(async (session) => {
        if (!session.pid)
            return;
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
        if (!session.paneId)
            return;
        const { execa: ex } = await import('execa');
        const tmuxKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;
        if (session.sshTarget) {
            // Remote: full-screen popup — reuse peek's remote pattern (LANG, docker -it, key-table)
            const hostConfig = tower.config.hosts.find(h => h.ssh === session.sshTarget);
            const interactivePrefix = hostConfig?.command_prefix?.replace(/^docker exec /, 'docker exec -it ');
            const paneSelect = `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index}' | grep '^${session.paneId} ' | head -1`;
            const setupCmd = `PINFO=\\$(${paneSelect}); SESS=\\$(echo \\$PINFO | awk '{print \\$2}'); WIDX=\\$(echo \\$PINFO | awk '{print \\$3}'); ` +
                `GO=_cctower_go_\\$\\$; tmux kill-session -t \\$GO 2>/dev/null; ` +
                `tmux new-session -d -s \\$GO -t \\$SESS && ` +
                `tmux set-option -t \\$GO window-size largest 2>/dev/null; ` +
                `tmux bind-key -T root ${tmuxKey} detach-client && ` +
                `TMUX= tmux attach -t \\$GO \\\\; select-window -t :\\$WIDX; ` +
                `tmux unbind-key -T root ${tmuxKey}; tmux kill-session -t \\$GO 2>/dev/null`;
            const remoteCmd = interactivePrefix
                ? `${interactivePrefix} sh -c 'export LANG=C.UTF-8; ${setupCmd.replace(/'/g, "'\\''")}'`
                : setupCmd;
            await tmux.displayPopup({
                width: '100%',
                height: '100%',
                title: ` ⌁ ${session.host}:${session.projectName} | ${tmuxKey} to close `,
                command: `ssh -t -o LogLevel=ERROR ${session.sshTarget} "${remoteCmd}"`,
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
                // Bind close key on TARGET session: switch back to exact tower window + reset key table
                await ex('tmux', ['bind-key', '-T', 'cctower-go', tmuxKey,
                    'run-shell', `tmux switch-client -t '${homeSession}:${homeWindow}' && tmux set-option -t ${targetSession} key-table root`,
                ]);
                // Switch to target
                await ex('tmux', ['switch-client', '-t', `${targetSession}:${targetWindow}`]);
                // Set key table on target session
                await ex('tmux', ['set-option', '-t', `${targetSession}`, 'key-table', 'cctower-go']);
            }
            catch { }
        }
    }, [tower]);
    const handleOpenNewSession = useCallback(() => {
        const activePaths = new Set(sessions.map(s => s.cwd).filter(Boolean));
        const projects = getRecentProjects(15).filter(p => !activePaths.has(p.path));
        setRecentProjects(projects);
        setView('new-session');
    }, [sessions]);
    const handleNewSession = useCallback(async (projectPath, host) => {
        const closeKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;
        const name = projectPath.split('/').pop() ?? projectPath;
        const claudeArgs = tower.config.claude_args ? ` ${tower.config.claude_args}` : '';
        setView('dashboard');
        const { execa: ex } = await import('execa');
        if (host) {
            // Remote: SSH + tmux new-session in separate session + peek
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
                    command: `tmux bind-key -T cctower-peek ${closeKey} detach-client && ssh -t ${host.ssh} "tmux attach -t ${sessionName}" ; tmux unbind-key -T cctower-peek ${closeKey}`,
                    closeOnExit: true,
                });
            }
            catch { }
        }
        else {
            // Local: create separate tmux session + peek
            const sessionName = `claude-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            try {
                await ex('tmux', ['new-session', '-d', '-s', sessionName, '-c', projectPath, `claude${claudeArgs}`]);
                await tmux.displayPopup({
                    width: '80%',
                    height: '80%',
                    title: ` ${name} (new) | ${closeKey} to close `,
                    command: `tmux bind-key -T cctower-peek ${closeKey} detach-client && TMUX= tmux attach -t ${sessionName} \\; set-option key-table cctower-peek ; tmux unbind-key -T cctower-peek ${closeKey}`,
                    closeOnExit: true,
                });
            }
            catch { }
        }
    }, [tower]);
    const handleQuit = useCallback(async () => {
        await tower.stop();
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
    return (_jsxs(Box, { width: termWidth, height: termHeight, flexDirection: "column", alignItems: "center", justifyContent: "center", children: [view === 'dashboard' && termHeight >= 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "flex-end", marginBottom: 0, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "cyan", children: ' ██████╗  ██████╗ ████████╗' }), _jsx(Text, { color: "cyan", children: '██╔════╝ ██╔════╝ ╚══██╔══╝' }), _jsx(Text, { color: "cyan", children: '██║      ██║         ██║' }), _jsx(Text, { color: "cyan", children: '╚██████╗ ╚██████╗    ██║' }), _jsx(Text, { color: "cyan", children: ' ╚═════╝  ╚═════╝    ╚═╝' })] }), _jsx(Box, { flexDirection: "column", justifyContent: "flex-end", marginLeft: 2, children: _jsxs(Text, { dimColor: true, children: [sessions.length, " sessions"] }) })] })), view === 'dashboard' && termHeight >= 20 && termHeight < 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "center", marginBottom: 0, children: [_jsx(Text, { color: "cyan", bold: true, children: "\u25C6 CCT" }), _jsxs(Text, { dimColor: true, children: [" ", sessions.length, " sessions"] })] })), _jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 2, paddingY: 1, width: boxWidth, children: [view === 'dashboard' && (_jsx(Dashboard, { sessions: sessions, tmuxCount: tmuxCount, maxTaskWidth: Math.max(10, boxWidth - 35), onSelect: handleSelect, onSend: handleSend, onPeek: handlePeek, onToggleFavorite: handleToggleFavorite, onRefresh: handleRefresh, onKill: handleKill, onGo: handleGo, onNewSession: handleOpenNewSession, onQuit: handleQuit })), view === 'new-session' && (_jsx(NewSession, { projects: recentProjects, hosts: tower.config.hosts.map(h => ({ name: h.name, ssh: h.ssh, commandPrefix: h.command_prefix })), onSelect: handleNewSession, onCancel: () => setView('dashboard') })), view === 'detail' && selectedSession && (_jsx(DetailView, { session: selectedSession, onBack: handleBack, onSend: handleSend, onPeek: handlePeek })), view === 'send' && selectedSession && (_jsx(SendInput, { session: selectedSession, confirmWhenBusy: tower.config.commands.confirm_when_busy, onSend: handleSendText, onCancel: () => setView('dashboard') }))] })] }));
}
//# sourceMappingURL=App.js.map