import { describe, it, expect } from 'vitest';
import { isPaneBusy } from '../../src/core/pane-title-status.js';

describe('isPaneBusy', () => {
  it('recognizes spinner glyphs (animating while busy) as busy', () => {
    expect(isPaneBusy('◐ interview')).toBe(true);
    expect(isPaneBusy('◓ manager')).toBe(true);
    expect(isPaneBusy('◑ popmux')).toBe(true);
    expect(isPaneBusy('◒ Rta-dev')).toBe(true);
  });

  it('recognizes the fixed idle glyph as not busy', () => {
    expect(isPaneBusy('✳ manager')).toBe(false);
    expect(isPaneBusy('✳ rta-ccu2-22549-exclusive-cond-threshold')).toBe(false);
  });

  it('returns undefined for titles without a recognized Claude Code glyph', () => {
    expect(isPaneBusy('kevin.park@builder-kr-4:~')).toBeUndefined();
    expect(isPaneBusy('routine_scheduler_monitoring.cxx - Nvim')).toBeUndefined();
    expect(isPaneBusy('')).toBeUndefined();
  });
});
