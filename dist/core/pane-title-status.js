/**
 * Claude Code renders a live status glyph as the tmux pane title — a
 * spinner (cycling through multiple frames) while actively generating
 * (thinking/executing/delegating), and a fixed glyph while idle/waiting for
 * input. This is authoritative ground truth set directly by the Claude Code
 * process itself via terminal title escapes, which tmux mirrors into
 * `pane_title`. Unlike hook events it cannot be lost, misordered, dropped by
 * a hook-name mismatch, or starved by a missing final `Stop` hook — it always
 * reflects Claude Code's actual current UI state.
 *
 * Observed empirically: '✳' stays fixed across samples while idle; '◐ ◓ ◑ ◒'
 * visibly cycle every render tick while busy (thinking/executing/agent).
 */
const SPINNER_GLYPHS = new Set(['◐', '◓', '◑', '◒']);
const IDLE_GLYPH = '✳';
/**
 * Returns true if the pane title's leading glyph indicates Claude Code is
 * actively working, false if it indicates idle/waiting, or undefined if the
 * title doesn't start with a recognized Claude Code status glyph (not a
 * Claude pane, or a format we don't know about yet — callers should leave
 * the existing status untouched in that case).
 */
export function isPaneBusy(title) {
    const glyph = title.trim().charAt(0);
    if (SPINNER_GLYPHS.has(glyph))
        return true;
    if (glyph === IDLE_GLYPH)
        return false;
    return undefined;
}
//# sourceMappingURL=pane-title-status.js.map