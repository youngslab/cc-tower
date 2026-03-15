import { describe, it, expect } from 'vitest';
import { parseJsonlLine } from '../../src/utils/jsonl-parser.js';

describe('parseJsonlLine', () => {
  it('returns null for empty line', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
  });

  it('returns null for incomplete/malformed JSON', () => {
    expect(parseJsonlLine('{')).toBeNull();
    expect(parseJsonlLine('not json at all')).toBeNull();
    expect(parseJsonlLine('{invalid}')).toBeNull();
  });

  it('parses a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2024-01-15T10:00:00.000Z',
      sessionId: 'abc123',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello!' }] },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('user');
    expect(result!.timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(result!.sessionId).toBe('abc123');
    expect(result!.userContent).toBe('Hello!');
  });

  it('parses an assistant message with stop_reason=end_turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-15T10:00:05.000Z',
      sessionId: 'abc123',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 120, cache_read_input_tokens: 0 },
        content: [{ type: 'text', text: 'Sure!' }],
      },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.stopReason).toBe('end_turn');
    expect(result!.model).toBe('claude-opus-4-5');
    expect(result!.usage).toMatchObject({ input_tokens: 25, output_tokens: 120 });
    expect(result!.usage!.cache_read_input_tokens).toBe(0);
  });

  it('parses an assistant message with stop_reason=tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'abc123',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-5',
        stop_reason: 'tool_use',
        usage: { input_tokens: 150, output_tokens: 80 },
        content: [],
      },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.stopReason).toBe('tool_use');
  });

  it('parses a progress message with type=agent_progress', () => {
    const line = JSON.stringify({
      type: 'progress',
      timestamp: '2024-01-15T10:00:15.000Z',
      sessionId: 'abc123',
      data: { type: 'agent_progress', agentId: 'subagent-42', message: 'Running...' },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('progress');
    expect(result!.progressType).toBe('agent_progress');
    expect(result!.agentId).toBe('subagent-42');
  });

  it('parses a progress message with type=hook_progress', () => {
    const line = JSON.stringify({
      type: 'progress',
      sessionId: 'abc123',
      data: { type: 'hook_progress' },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('progress');
    expect(result!.progressType).toBe('hook_progress');
  });

  it('parses a system message with subtype=turn_duration', () => {
    const line = JSON.stringify({
      type: 'system',
      timestamp: '2024-01-15T10:00:20.000Z',
      sessionId: 'abc123',
      subtype: 'turn_duration',
      durationMs: 4823,
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('system');
    expect(result!.systemSubtype).toBe('turn_duration');
    expect(result!.durationMs).toBe(4823);
  });

  it('parses unknown type gracefully', () => {
    const line = JSON.stringify({ type: 'something-new', foo: 'bar' });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('unknown');
  });

  it('parses file-history-snapshot type', () => {
    const line = JSON.stringify({ type: 'file-history-snapshot', sessionId: 's1' });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('file-history-snapshot');
  });
});
