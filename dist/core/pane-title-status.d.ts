/**
 * Returns true if the pane title's leading glyph indicates Claude Code is
 * actively working, false if it indicates idle/waiting, or undefined if the
 * title doesn't start with a recognized Claude Code status glyph (not a
 * Claude pane, or a format we don't know about yet — callers should leave
 * the existing status untouched in that case).
 */
export declare function isPaneBusy(title: string): boolean | undefined;
