import React, { useState, useCallback } from 'react';
import { Box, useApp } from 'ink';
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

  return (
    <Box flexDirection="column">
      {view === 'dashboard' && (
        <Dashboard
          sessions={sessions}
          tmuxCount={tmuxCount}
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
  );
}
