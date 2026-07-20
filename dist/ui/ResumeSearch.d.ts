import { PastSessionByCwd } from './NewSession.js';
interface Props {
    /** Getter; re-invoked whenever `generation` changes (the disk scan completes). */
    getSessions: () => PastSessionByCwd[];
    /** Bumped by the caller when the background scan finishes, to refresh the list. */
    generation?: number;
    /** True while the first (cold) disk scan is in flight — shows a footer hint. */
    scanning?: boolean;
    /** Called when a past session is chosen (Enter) — caller resurrects it. */
    onSelect: (session: PastSessionByCwd) => void;
    /** Called on Escape — close the overlay without resurrecting. */
    onCancel: () => void;
    /** Terminal height, for viewport scrolling — the list can be much longer
     * than the screen (100+ resumable sessions), and every row is fixed-height
     * (unlike Dashboard's session blocks), so a simple centered window suffices. */
    termHeight?: number;
}
/**
 * Fuzzy-search overlay over DEAD/past sessions. Enter resurrects the chosen
 * session via `claude --resume`. Searches by label and the cwd basename
 * (past sessions frequently have no label). Navigation is arrow-only so every
 * printable character (incl. j/k) is typeable into the query.
 */
export declare function ResumeSearch({ getSessions, generation, scanning, onSelect, onCancel, termHeight }: Props): import("react/jsx-runtime").JSX.Element;
export {};
