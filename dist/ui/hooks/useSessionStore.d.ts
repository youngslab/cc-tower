import { SessionStore, Session } from '../../core/session-store.js';
export declare function useSessionStore(store: SessionStore): {
    sessions: Session[];
    tmuxCount: number;
};
