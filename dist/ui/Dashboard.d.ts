import { Session } from '../core/session-store.js';
interface Props {
    sessions: Session[];
    tmuxCount: number;
    maxTaskWidth: number;
    onSelect: (session: Session) => void;
    onSend: (session: Session) => void;
    onPeek: (session: Session) => void;
    onToggleFavorite: (session: Session) => void;
    onNewSession: () => void;
    onRefresh: (session: Session) => void;
    onQuit: () => void;
}
export declare function Dashboard({ sessions, tmuxCount, maxTaskWidth, onSelect, onSend, onPeek, onToggleFavorite, onNewSession, onRefresh, onQuit }: Props): import("react/jsx-runtime").JSX.Element;
export {};
