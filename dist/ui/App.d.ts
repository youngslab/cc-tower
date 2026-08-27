import { Tower } from '../core/tower.js';
interface Props {
    tower: Tower;
    /**
     * Picker mode: TUI renders normally, but action keys write a single-line
     * JSON result to `outputPath` and `process.exit(0)`. The dashboard's
     * dashboard-mode handlers (switch-client, kill, …) are bypassed.
     */
    pickerMode?: boolean;
    outputPath?: string;
    /**
     * Pane the user was actually in when they opened the picker (F12) —
     * captured by popmux-go via `tmux display-message` before the popup
     * steals focus. Takes priority over the persisted last-browsed cursor so
     * F12 starts on "the session I'm looking at", not wherever the cursor
     * happened to be left in a previous picker session.
     */
    originPaneId?: string;
}
export declare function App({ tower, pickerMode, outputPath, originPaneId }: Props): import("react/jsx-runtime").JSX.Element;
export {};
