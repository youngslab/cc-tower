import { Session } from '../core/session-store.js';
interface Props {
    sessions: Session[];
    tmuxCount: number;
    maxTaskWidth: number;
    /** Real terminal width/height, and rows the header block above us already occupies. */
    termWidth: number;
    termHeight: number;
    headerHeight: number;
    cursorIdentity: string | null;
    onCursorChange: (identity: string | null) => void;
    onSwapFavoriteOrder: (idA: string, idB: string) => void;
    onSelect: (session: Session) => void;
    onOpenSearch: () => void;
    onOpenResumeSearch: () => void;
    onToggleFavorite: (session: Session) => void;
    onNewSession: () => void;
    onRefresh: (session: Session) => void;
    onKill: (session: Session) => void;
    onGo: (session: Session) => void;
    onDisplayOrderChange: (order: string[]) => void;
    initialDisplayOrder: string[];
    onQuit: () => void;
    pickerMode?: boolean;
}
export declare function Dashboard({ sessions, tmuxCount, maxTaskWidth, termWidth, termHeight, headerHeight, cursorIdentity, onCursorChange, onSwapFavoriteOrder, onSelect, onOpenSearch, onOpenResumeSearch, onToggleFavorite, onNewSession, onRefresh, onKill, onGo, onQuit, onDisplayOrderChange, initialDisplayOrder, pickerMode }: Props): import("react/jsx-runtime").JSX.Element;
export {};
