import { useState, useEffect } from 'react';
export function useSessionStore(store) {
    const [sessions, setSessions] = useState(store.getAll());
    useEffect(() => {
        const update = () => setSessions([...store.getAll()]);
        store.on('session-added', update);
        store.on('session-removed', update);
        store.on('session-updated', update);
        return () => {
            store.off('session-added', update);
            store.off('session-removed', update);
            store.off('session-updated', update);
        };
    }, [store]);
    // Sort: tmux sessions first, then non-tmux (dim), sorted by status priority
    const sorted = [...sessions].sort((a, b) => {
        if (a.hasTmux !== b.hasTmux)
            return a.hasTmux ? -1 : 1;
        const statusOrder = { executing: 0, thinking: 1, agent: 2, idle: 3, dead: 4 };
        return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
    });
    return { sessions: sorted, tmuxCount: sessions.filter(s => s.hasTmux).length };
}
//# sourceMappingURL=useSessionStore.js.map