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
}
export declare function App({ tower, pickerMode, outputPath }: Props): import("react/jsx-runtime").JSX.Element;
export {};
