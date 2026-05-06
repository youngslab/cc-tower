import { Session } from '../core/session-store.js';
interface Props {
    sessions: Session[];
    tmuxCount: number;
    maxTaskWidth: number;
    cursorIdentity: string | null;
    onCursorChange: (identity: string | null) => void;
    onSwapFavoriteOrder: (idA: string, idB: string) => void;
    onSelect: (session: Session) => void;
    onSend: (session: Session) => void;
    onToggleFavorite: (session: Session) => void;
    onNewSession: () => void;
    onRefresh: (session: Session) => void;
    onKill: (session: Session) => void;
    onGo: (session: Session) => void;
    onDisplayOrderChange: (order: string[]) => void;
    initialDisplayOrder: string[];
    onQuit: () => void;
}
export declare function Dashboard({ sessions, tmuxCount, maxTaskWidth, cursorIdentity, onCursorChange, onSwapFavoriteOrder, onSelect, onSend, onToggleFavorite, onNewSession, onRefresh, onKill, onGo, onQuit, onDisplayOrderChange, initialDisplayOrder }: Props): import("react/jsx-runtime").JSX.Element;
export {};
