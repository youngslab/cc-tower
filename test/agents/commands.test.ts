import { describe, expect, it } from 'vitest';
import { agentWindowName, buildAgentCommand } from '../../src/agents/commands.js';

describe('agent command builder', () => {
  it('builds Claude fresh and resume commands', () => {
    expect(buildAgentCommand({ agentId: 'claude', cwd: '/repo' })).toBe('claude');
    expect(buildAgentCommand({ agentId: 'claude', cwd: '/repo', resumeId: 'abc-123', claudeArgs: '--dangerously-skip-permissions' }))
      .toBe("claude --resume 'abc-123' --dangerously-skip-permissions");
    expect(buildAgentCommand({ agentId: 'claude', cwd: '/repo', claudeBin: '/home/me/bin/claude' }))
      .toBe("'/home/me/bin/claude'");
  });

  it('builds Codex fresh and resume commands with cwd', () => {
    expect(buildAgentCommand({ agentId: 'codex', cwd: '/home/me/project' })).toBe("codex -C '/home/me/project'");
    expect(buildAgentCommand({ agentId: 'codex', cwd: "/tmp/it's-here", resumeId: '019f' }))
      .toBe("codex resume '019f' -C '/tmp/it'\"'\"'s-here'");
  });

  it('uses agent-specific window names', () => {
    expect(agentWindowName('claude', 'my project')).toBe('claude-my-project');
    expect(agentWindowName('codex', 'my project')).toBe('codex-my-project');
  });
});
