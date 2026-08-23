import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCodexRolloutContext, summarizeCodexThread } from '../../../src/agents/codex/rollout-summary.js';

describe('codex rollout summary provider helpers', () => {
  it('extracts recent Codex activity from rollout JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '초기 요청' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '최근 작업을 완료했습니다.' } }),
    ].join('\n'));

    expect(readCodexRolloutContext(file)).toBe('최근 작업을 완료했습니다.');
  });

  it('builds goal and context summaries from a Codex thread row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '테스트를 통과시켰습니다.' } }) + '\n');

    expect(summarizeCodexThread({ id: 'thread-1', preview: 'Codex 지원 구현', rolloutPath: file })).toEqual({
      goal: 'Codex 지원 구현',
      context: '테스트를 통과시켰습니다.',
    });
  });
});
