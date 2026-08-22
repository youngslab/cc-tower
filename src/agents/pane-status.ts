import { normalizeAgentId, type AgentId } from './types.js';

/** Claude Code title glyphs: spinner while busy, fixed star while idle. */
const CLAUDE_SPINNER_GLYPHS = new Set(['◐', '◓', '◑', '◒']);
const CLAUDE_IDLE_GLYPH = '✳';

/** Codex title glyphs: braille spinner while busy, plain title while idle. */
const CODEX_SPINNER_GLYPHS = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);

export function inferClaudePaneBusy(title: string): boolean | undefined {
  const glyph = title.trim().charAt(0);
  if (CLAUDE_SPINNER_GLYPHS.has(glyph)) return true;
  if (glyph === CLAUDE_IDLE_GLYPH) return false;
  return undefined;
}

export function inferCodexPaneBusy(title: string): boolean | undefined {
  const glyph = title.trim().charAt(0);
  if (CODEX_SPINNER_GLYPHS.has(glyph)) return true;
  return false;
}

export function inferPaneBusyForAgent(title: string, agentId: AgentId | undefined): boolean | undefined {
  return normalizeAgentId(agentId) === 'codex'
    ? inferCodexPaneBusy(title)
    : inferClaudePaneBusy(title);
}
