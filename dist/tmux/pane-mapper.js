import { tmux } from './commands.js';
import { resolvePaneForPid } from '../utils/pid-resolver.js';
/**
 * Map a Claude PID to a tmux pane via ppid chain walking.
 * Returns { paneId: undefined, hasTmux: false } if tmux is not available.
 * Returns { paneId: undefined, hasTmux: true } if no matching pane found.
 */
export async function mapPidToPane(claudePid) {
    const hasTmux = await tmux.isAvailable();
    if (!hasTmux) {
        return { paneId: undefined, hasTmux: false };
    }
    let panes;
    try {
        panes = await tmux.listPanes();
    }
    catch {
        return { paneId: undefined, hasTmux: true };
    }
    const match = await resolvePaneForPid(claudePid, panes);
    return {
        paneId: match?.paneId,
        hasTmux: true,
    };
}
//# sourceMappingURL=pane-mapper.js.map