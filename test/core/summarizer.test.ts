import { describe, it, expect } from 'vitest';
import { Summarizer } from '../../src/core/summarizer.js';
import { ParsedMessage } from '../../src/utils/jsonl-parser.js';

describe('Summarizer', () => {
  const summarizer = new Summarizer();

  describe('Tier 1: Structural extraction', () => {
    it('summarizes user message by truncating to 80 chars', () => {
      const event: ParsedMessage = {
        type: 'user',
        userContent: 'Fix the failing migration test for nullable column handling in the database schema',
      };
      const summary = summarizer.summarize('thinking', event, []);
      expect(summary.summary.length).toBeLessThanOrEqual(120);
      expect(summary.summary).toContain('Fix the failing migration');
      expect(summary.tier).toBe(1);
    });

    it('summarizes tool_use with tool name', () => {
      const event: ParsedMessage = {
        type: 'assistant',
        stopReason: 'tool_use',
      };
      const recentMessages: ParsedMessage[] = [];
      const summary = summarizer.summarize('executing', event, recentMessages);
      expect(summary.tier).toBe(1);
    });

    it('summarizes end_turn with assistant final text', () => {
      const event: ParsedMessage = {
        type: 'assistant',
        stopReason: 'end_turn',
      };
      const recentMessages: ParsedMessage[] = [
        { type: 'user', userContent: 'Fix the bug' },
        { type: 'assistant', stopReason: 'end_turn' },
      ];
      const summary = summarizer.summarize('idle', event, recentMessages);
      expect(summary.transition).toContain('idle');
      expect(summary.tier).toBe(1);
    });
  });

  describe('Tier 2: Pattern matching', () => {
    it('detects test results from content', () => {
      const event: ParsedMessage = {
        type: 'assistant',
        stopReason: 'end_turn',
      };
      const content = 'Tests: 8 passed, 1 failed, 9 total';
      const summary = summarizer.summarizeWithContent('idle', event, content);
      expect(summary.details?.testResult).toBeDefined();
      expect(summary.details!.testResult!.passed).toBe(8);
      expect(summary.details!.testResult!.failed).toBe(1);
      expect(summary.tier).toBe(2);
    });

    it('detects PASS/FAIL pattern', () => {
      const content = 'PASS src/foo.test.ts\nPASS src/bar.test.ts\nFAIL src/baz.test.ts';
      const summary = summarizer.summarizeWithContent('idle', { type: 'assistant', stopReason: 'end_turn' }, content);
      expect(summary.details?.testResult).toBeDefined();
      expect(summary.details!.testResult!.passed).toBe(2);
      expect(summary.details!.testResult!.failed).toBe(1);
      expect(summary.tier).toBe(2);
    });

    it('detects TypeScript build errors', () => {
      const content = 'error TS2345: Argument of type...\nerror TS2322: Type...\nerror TS2304: Cannot find name...';
      const summary = summarizer.summarizeWithContent('idle', { type: 'assistant', stopReason: 'end_turn' }, content);
      expect(summary.details?.error).toContain('3 error');
      expect(summary.tier).toBe(2);
    });

    it('detects git commit', () => {
      const content = 'Created commit abc1234: Fix migration issue';
      const summary = summarizer.summarizeWithContent('idle', { type: 'assistant', stopReason: 'end_turn' }, content);
      expect(summary.summary).toContain('abc1234');
      expect(summary.tier).toBe(2);
    });

    it('detects file edits', () => {
      const content = 'Edit: src/migrations/003.ts:45-52';
      const summary = summarizer.summarizeWithContent('idle', { type: 'assistant', stopReason: 'end_turn' }, content);
      expect(summary.details?.filesChanged).toContain('src/migrations/003.ts');
      expect(summary.tier).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles empty user content', () => {
      const event: ParsedMessage = { type: 'user', userContent: '' };
      const summary = summarizer.summarize('thinking', event, []);
      expect(summary.summary).toBeDefined();
    });

    it('handles undefined user content', () => {
      const event: ParsedMessage = { type: 'user' };
      const summary = summarizer.summarize('thinking', event, []);
      expect(summary.summary).toBeDefined();
    });

    it('falls back to Tier 1 when no patterns match', () => {
      const content = 'Just some regular text without any patterns';
      const summary = summarizer.summarizeWithContent('idle', { type: 'assistant', stopReason: 'end_turn' }, content);
      expect(summary.tier).toBe(1);
    });
  });
});
