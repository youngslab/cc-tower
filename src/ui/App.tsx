import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { Tower } from '../core/tower.js';
import { Session } from '../core/session-store.js';
import { useSessionStore } from './hooks/useSessionStore.js';
import { useTmux } from './hooks/useTmux.js';
import { tmux } from '../tmux/commands.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SendInput } from './SendInput.js';
import { NewSession, PastSession, PastSessionByCwd } from './NewSession.js';
import { getRecentProjects, RecentProject } from '../utils/recent-projects.js';

type View = 'dashboard' | 'detail' | 'send' | 'new-session';

interface Props {
  tower: Tower;
}

export function App({ tower }: Props) {
  const { exit } = useApp();
  const { sessions, tmuxCount } = useSessionStore(tower.store);
  const { send, peek } = useTmux(tower.config.keys.close);
  const [view, setView] = useState<View>('dashboard');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  const handleSelect = useCallback((session: Session) => {
    setSelectedSession(session);
    setView('detail');
  }, []);

  const handleSend = useCallback((session: Session) => {
    setSelectedSession(session);
    setView('send');
  }, []);

  const handlePeek = useCallback(async (session: Session) => {
    if (!session.hasTmux && !session.sshTarget) return;
    await peek(session);
  }, [peek]);

  const handleSendText = useCallback(async (text: string) => {
    if (selectedSession) {
      await send(selectedSession, text);
    }
    setView(view === 'send' ? 'dashboard' : 'detail');
  }, [selectedSession, send, view]);

  const handleBack = useCallback(() => {
    setView('dashboard');
    setSelectedSession(null);
  }, []);

  const handleToggleFavorite = useCallback((session: Session) => {
    const nowFav = !session.favorite;
    tower.store.update(session.sessionId, { favorite: nowFav, favoritedAt: nowFav ? Date.now() : undefined });
  }, [tower]);

  const handleRefresh = useCallback((session: Session) => {
    void tower.refreshSession(session.sessionId);
  }, [tower]);

  const handleKill = useCallback(async (session: Session) => {
    if (!session.pid) return;
    try {
      if (session.sshTarget) {
        const hostConfig = tower.config.hosts.find(h => h.ssh === session.sshTarget);
        const killCmd = `kill ${session.pid}`;
        const cmd = hostConfig?.command_prefix
          ? `${hostConfig.command_prefix} sh -c '${killCmd}'`
          : killCmd;
        const { spawn: sp } = await import('node:child_process');
        sp('ssh', [session.sshTarget, cmd], { stdio: 'ignore', detached: true });
      } else {
        process.kill(session.pid, 'SIGTERM');
      }
    } catch {}
  }, [tower]);

  const handleGo = useCallback(async (session: Session) => {
    if (!session.paneId) return;
    const { execa: ex } = await import('execa');
    const tmuxKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;

    if (session.sshTarget) {
      // Remote: full-screen popup — tmux commands run on SSH host, NOT inside commandPrefix container
      const paneSelect = `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index}' | grep '^${session.paneId} ' | head -1`;
      const setupCmd =
        `PINFO=\\$(${paneSelect}); SESS=\\$(echo \\$PINFO | awk '{print \\$2}'); WIDX=\\$(echo \\$PINFO | awk '{print \\$3}'); ` +
        `GO=_cctower_go_\\$\\$; tmux kill-session -t \\$GO 2>/dev/null; ` +
        `tmux new-session -d -s \\$GO -t \\$SESS && ` +
        `tmux set-option -t \\$GO window-size largest 2>/dev/null; ` +
        `tmux bind-key -T root ${tmuxKey} detach-client && ` +
        `TMUX= tmux attach -t \\$GO \\\\; select-window -t :\\$WIDX; ` +
        `tmux unbind-key -T root ${tmuxKey}; tmux kill-session -t \\$GO 2>/dev/null`;
      const remoteCmd = setupCmd;
      await tmux.displayPopup({
        width: '100%',
        height: '100%',
        title: ` ⌁ ${session.host}:${session.projectName} | ${tmuxKey} to close `,
        command: `ssh -t -o LogLevel=ERROR ${session.sshTarget} "${remoteCmd}"`,
        closeOnExit: true,
      });
    } else {
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
      } catch {}
    }
  }, [tower]);

  const handleOpenNewSession = useCallback(() => {
    const activePaths = new Set(sessions.map(s => s.cwd).filter(Boolean));
    const projects = getRecentProjects(15).filter(p => !activePaths.has(p.path));
    setRecentProjects(projects);
    setView('new-session');
  }, [sessions]);

  const getPastSessions = useCallback((cwd: string): PastSession[] => {
    return tower.store.getPastSessionsByCwd(cwd);
  }, [tower]);

  const getPastSessionsByTarget = useCallback((sshTarget?: string): PastSessionByCwd[] => {
    return tower.store.getPastSessionsByTarget(sshTarget);
  }, [tower]);

  const handleNewSession = useCallback(async (projectPath: string, host?: { name: string; ssh: string; commandPrefix?: string }, resumeSessionId?: string) => {
    const closeKey = tower.config.keys.close === 'Escape' ? 'Escape' : tower.config.keys.close;
    const name = projectPath.split('/').pop() ?? projectPath;
    const resumeArg = resumeSessionId ? ` --resume ${resumeSessionId}` : '';
    const claudeArgs = (tower.config.claude_args ? ` ${tower.config.claude_args}` : '') + resumeArg;
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
      } catch {}
    } else {
      // Local: add a window to the hive session (create hive if needed)
      const hiveSession = 'cc-tower-hive';
      const windowName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
      try {
        let sessionExists = false;
        try { await ex('tmux', ['has-session', '-t', hiveSession]); sessionExists = true; } catch {}

        let windowIndex: string;
        if (!sessionExists) {
          const { stdout } = await ex('tmux', [
            'new-session', '-d', '-s', hiveSession, '-n', windowName, '-c', projectPath,
            '-P', '-F', '#{window_index}', `claude${claudeArgs}`,
          ]);
          windowIndex = stdout.trim();
        } else {
          const { stdout } = await ex('tmux', [
            'new-window', '-t', hiveSession, '-n', windowName, '-c', projectPath,
            '-P', '-F', '#{window_index}', `claude${claudeArgs}`,
          ]);
          windowIndex = stdout.trim();
        }

        await tmux.displayPopup({
          width: '80%',
          height: '80%',
          title: ` ${name} (new) | ${closeKey} to close `,
          command: `tmux bind-key -T cctower-peek ${closeKey} detach-client && TMUX= tmux attach -t ${hiveSession}:${windowIndex} \\; set-option key-table cctower-peek ; tmux unbind-key -T cctower-peek ${closeKey}`,
          closeOnExit: true,
        });
      } catch {}
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
    return (
      <Box width={termWidth} height={termHeight} alignItems="center" justifyContent="center">
        <Text color="yellow">Terminal too small ({termWidth}x{termHeight}). Need at least {MIN_WIDTH}x{MIN_HEIGHT}.</Text>
      </Box>
    );
  }

  // Dynamic sizing: use 70% of terminal width
  const boxWidth = Math.max(MIN_WIDTH, Math.min(termWidth - 4, Math.floor(termWidth * 0.7)));

  return (
    <Box
      width={termWidth}
      height={termHeight}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {view === 'dashboard' && termHeight >= 30 && (
        <Box width={boxWidth} justifyContent="flex-start" alignItems="flex-end" marginBottom={0}>
          <Box flexDirection="column">
            <Text color="cyan">{' ██████╗  ██████╗ ████████╗'}</Text>
            <Text color="cyan">{'██╔════╝ ██╔════╝ ╚══██╔══╝'}</Text>
            <Text color="cyan">{'██║      ██║         ██║'}</Text>
            <Text color="cyan">{'╚██████╗ ╚██████╗    ██║'}</Text>
            <Text color="cyan">{' ╚═════╝  ╚═════╝    ╚═╝'}</Text>
          </Box>
          <Box flexDirection="column" justifyContent="flex-end" marginLeft={2}>
            <Text dimColor>{sessions.length} sessions</Text>
          </Box>
        </Box>
      )}
      {view === 'dashboard' && termHeight >= 20 && termHeight < 30 && (
        <Box width={boxWidth} justifyContent="flex-start" alignItems="center" marginBottom={0}>
          <Text color="cyan" bold>◆ CCT</Text>
          <Text dimColor> {sessions.length} sessions</Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        width={boxWidth}
      >
        {view === 'dashboard' && (
          <Dashboard
            sessions={sessions}
            tmuxCount={tmuxCount}
            maxTaskWidth={Math.max(10, boxWidth - 35)}
            onSelect={handleSelect}
            onSend={handleSend}
            onPeek={handlePeek}
            onToggleFavorite={handleToggleFavorite}
            onRefresh={handleRefresh}
            onKill={handleKill}
            onGo={handleGo}
            onNewSession={handleOpenNewSession}
            onQuit={handleQuit}
          />
        )}

        {view === 'new-session' && (
          <NewSession
            projects={recentProjects}
            hosts={tower.config.hosts.map(h => ({ name: h.name, ssh: h.ssh, commandPrefix: h.command_prefix }))}
            onSelect={handleNewSession}
            onCancel={() => setView('dashboard')}
            getPastSessions={getPastSessions}
            getPastSessionsByTarget={getPastSessionsByTarget}
            onDeleteSession={(id) => tower.store.deletePersistedSession(id)}
          />
        )}

        {view === 'detail' && selectedSession && (
          <DetailView
            session={selectedSession}
            onBack={handleBack}
            onSend={handleSend}
            onPeek={handlePeek}
          />
        )}

        {view === 'send' && selectedSession && (
          <SendInput
            session={selectedSession}
            confirmWhenBusy={tower.config.commands.confirm_when_busy}
            onSend={handleSendText}
            onCancel={() => setView('dashboard')}
          />
        )}
      </Box>
    </Box>
  );
}
