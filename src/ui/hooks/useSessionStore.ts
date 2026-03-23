import { useState, useEffect, useRef } from 'react';
import { SessionStore, Session } from '../../core/session-store.js';

export function useSessionStore(store: SessionStore) {
  const [sessions, setSessions] = useState<Session[]>(store.getAll());
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const flush = () => {
      pendingRef.current = false;
      setSessions([...store.getAll()]);
    };
    const throttledUpdate = () => {
      if (timerRef.current) { pendingRef.current = true; return; }
      flush();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingRef.current) flush();
      }, 500);
    };
    store.on('session-added', throttledUpdate);
    store.on('session-removed', throttledUpdate);
    store.on('session-updated', throttledUpdate);
    return () => {
      store.off('session-added', throttledUpdate);
      store.off('session-removed', throttledUpdate);
      store.off('session-updated', throttledUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [store]);

  // Sort: tmux sessions first, then non-tmux (dim), sorted by status priority
  const sorted = [...sessions].sort((a, b) => {
    if (a.hasTmux !== b.hasTmux) return a.hasTmux ? -1 : 1;
    const statusOrder = { executing: 0, thinking: 1, agent: 2, idle: 3, dead: 4 };
    return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
  });

  return { sessions: sorted, tmuxCount: sessions.filter(s => s.hasTmux).length };
}
