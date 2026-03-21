import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { useSessionStore } from './hooks/useSessionStore.js';
import { useTmux } from './hooks/useTmux.js';
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
    const handleOpenNewSession = useCallback(() => {
        const activePaths = new Set(sessions.map(s => s.cwd).filter(Boolean));
        const projects = getRecentProjects(15).filter(p => !activePaths.has(p.path));
        setRecentProjects(projects);
        setView('new-session');
    }, [sessions]);
    const handleNewSession = useCallback(async (projectPath) => {
        const { spawn } = await import('node:child_process');
        spawn('tmux', ['new-window', '-c', projectPath, 'claude'], { detached: true, stdio: 'ignore' });
        setView('dashboard');
    }, []);
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
    return (_jsxs(Box, { width: termWidth, height: termHeight, flexDirection: "column", alignItems: "center", justifyContent: "center", children: [view === 'dashboard' && termHeight >= 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "flex-end", marginBottom: 0, children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "cyan", children: ' ██████╗  ██████╗ ████████╗' }), _jsx(Text, { color: "cyan", children: '██╔════╝ ██╔════╝ ╚══██╔══╝' }), _jsx(Text, { color: "cyan", children: '██║      ██║         ██║' }), _jsx(Text, { color: "cyan", children: '╚██████╗ ╚██████╗    ██║' }), _jsx(Text, { color: "cyan", children: ' ╚═════╝  ╚═════╝    ╚═╝' })] }), _jsx(Box, { flexDirection: "column", justifyContent: "flex-end", marginLeft: 2, children: _jsxs(Text, { dimColor: true, children: [sessions.length, " sessions"] }) })] })), view === 'dashboard' && termHeight >= 20 && termHeight < 30 && (_jsxs(Box, { width: boxWidth, justifyContent: "flex-start", alignItems: "center", marginBottom: 0, children: [_jsx(Text, { color: "cyan", bold: true, children: "\u25C6 CCT" }), _jsxs(Text, { dimColor: true, children: [" ", sessions.length, " sessions"] })] })), _jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 2, paddingY: 1, width: boxWidth, children: [view === 'dashboard' && (_jsx(Dashboard, { sessions: sessions, tmuxCount: tmuxCount, maxTaskWidth: Math.max(10, boxWidth - 59), onSelect: handleSelect, onSend: handleSend, onPeek: handlePeek, onToggleFavorite: handleToggleFavorite, onRefresh: handleRefresh, onNewSession: handleOpenNewSession, onQuit: handleQuit })), view === 'new-session' && (_jsx(NewSession, { projects: recentProjects, onSelect: handleNewSession, onCancel: () => setView('dashboard') })), view === 'detail' && selectedSession && (_jsx(DetailView, { session: selectedSession, onBack: handleBack, onSend: handleSend, onPeek: handlePeek })), view === 'send' && selectedSession && (_jsx(SendInput, { session: selectedSession, confirmWhenBusy: tower.config.commands.confirm_when_busy, onSend: handleSendText, onCancel: () => setView('dashboard') }))] })] }));
}
//# sourceMappingURL=App.js.map