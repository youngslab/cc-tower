import { tmux, PaneInfo } from './commands.js';
import { resolvePaneForPid } from '../utils/pid-resolver.js';

export interface MappingResult {
  paneId: string | undefined;
  hasTmux: boolean;
}

// Cached pane list for batch operations
let cachedPanes: PaneInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

async function getPanes(): Promise<PaneInfo[] | null> {
  const now = Date.now();
  if (cachedPanes && (now - cacheTime) < CACHE_TTL) return cachedPanes;
  const hasTmux = await tmux.isAvailable();
  if (!hasTmux) return null;
  try {
    cachedPanes = await tmux.listPanes();
    cacheTime = now;
    return cachedPanes;
  } catch {
    return null;
  }
}

/**
 * Map a Claude PID to a tmux pane via ppid chain walking.
 * Returns { paneId: undefined, hasTmux: false } if tmux is not available.
 * Returns { paneId: undefined, hasTmux: true } if no matching pane found.
 */
export async function mapPidToPane(claudePid: number): Promise<MappingResult> {
  const panes = await getPanes();
  if (panes === null) {
    return { paneId: undefined, hasTmux: false };
  }
  const match = await resolvePaneForPid(claudePid, panes);
  return {
    paneId: match?.paneId,
    hasTmux: true,
  };
}
