import { Session } from '../core/session-store.js';
interface Props {
    sessions: Session[];
    /** Called when a result is chosen (Enter). The dashboard moves its cursor here. */
    onSelect: (session: Session) => void;
    /** Called on Escape — close the overlay without selecting. */
    onCancel: () => void;
}
/**
 * Fuzzy-search overlay over named sessions. Typing filters by `label`
 * (subsequence match); Enter selects the highlighted result. Selection does
 * NOT navigate — the caller repositions the dashboard cursor to that session.
 *
 * Navigation is arrow-only so every printable character (incl. j/k) is typeable
 * into the query.
 */
export declare function SessionSearch({ sessions, onSelect, onCancel }: Props): import("react/jsx-runtime").JSX.Element;
export {};
