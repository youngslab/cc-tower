import { describe, it, expect } from 'vitest';
import { cwdToSlug } from '../../src/utils/slug.js';

describe('cwdToSlug', () => {
  it('converts a normal absolute path', () => {
    expect(cwdToSlug('/home/user/workspace/app')).toBe('-home-user-workspace-app');
  });

  it('converts root path', () => {
    expect(cwdToSlug('/')).toBe('-');
  });

  it('handles trailing slash', () => {
    expect(cwdToSlug('/home/user/')).toBe('-home-user-');
  });

  it('handles path with spaces', () => {
    expect(cwdToSlug('/home/user/my project')).toBe('-home-user-my project');
  });

  it('handles single-segment path', () => {
    expect(cwdToSlug('/workspace')).toBe('-workspace');
  });

  it('handles empty string', () => {
    expect(cwdToSlug('')).toBe('');
  });
});
