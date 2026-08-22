import { describe, expect, it } from 'vitest';
import { projectArtifactsDir, sessionArtifactPath } from '../../../src/agents/claude/artifacts.js';

describe('Claude artifact paths', () => {
  it('builds local JSONL artifact paths with cwd slugging', () => {
    expect(projectArtifactsDir({ rootDir: '/home/me/.claude', cwd: '/repo/app' }))
      .toBe('/home/me/.claude/projects/-repo-app');
    expect(sessionArtifactPath({ rootDir: '/home/me/.claude', cwd: '/repo/app', sessionId: 'sid-1' }))
      .toBe('/home/me/.claude/projects/-repo-app/sid-1.jsonl');
  });

  it('builds remote JSONL artifact paths without local path normalization', () => {
    expect(projectArtifactsDir({ rootDir: '~/.claude', cwd: '/repo/app', remote: true }))
      .toBe('~/.claude/projects/-repo-app');
    expect(sessionArtifactPath({ rootDir: '~/.claude', cwd: '/repo/app', sessionId: 'sid-1', remote: true }))
      .toBe('~/.claude/projects/-repo-app/sid-1.jsonl');
  });
});
