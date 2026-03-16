import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { Tower } from '../core/tower.js';
import { Session } from '../core/session-store.js';
import { useSessionStore } from './hooks/useSessionStore.js';
import { useTmux } from './hooks/useTmux.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SendInput } from './SendInput.js';

type View = 'dashboard' | 'detail' | 'send';

interface Props {
  tower: Tower;
}

export function App({ tower }: Props) {
  const { exit } = useApp();
  const { sessions, tmuxCount } = useSessionStore(tower.store);
  const { send, peek, zoom } = useTmux();
  const [view, setView] = useState<View>('dashboard');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const handleSelect = useCallback((session: Session) => {
    setSelectedSession(session);
    setView('detail');
  }, []);

  const handleSend = useCallback((session: Session) => {
    setSelectedSession(session);
    setView('send');
  }, []);

  const handlePeek = useCallback(async (session: Session) => {
    if (!session.hasTmux) return;
    await peek(session);
  }, [peek]);

  const handleZoom = useCallback(async (session: Session) => {
    if (!session.hasTmux) return;
    await zoom(session);
  }, [zoom]);

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

  // Dynamic sizing: use 90% of terminal, capped at reasonable max
  const boxWidth = Math.min(termWidth - 4, Math.max(MIN_WIDTH, Math.floor(termWidth * 0.9)));

  return (
    <Box
      width={termWidth}
      height={termHeight}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
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
            maxTaskWidth={Math.max(10, boxWidth - 50)}
            onSelect={handleSelect}
            onSend={handleSend}
            onPeek={handlePeek}
            onZoom={handleZoom}
            onQuit={handleQuit}
          />
        )}

        {view === 'detail' && selectedSession && (
          <DetailView
            session={selectedSession}
            onBack={handleBack}
            onSend={handleSend}
            onPeek={handlePeek}
            onZoom={handleZoom}
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
