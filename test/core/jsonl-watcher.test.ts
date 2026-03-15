import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { JsonlWatcher } from '../../src/core/jsonl-watcher.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('JsonlWatcher', () => {
  let tmpDir: string;
  let watcher: JsonlWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tower-test-'));
    watcher = new JsonlWatcher();
  });

  afterEach(() => {
    watcher.unwatchAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('coldStartScan', () => {
    it('returns idle when last message has stop_reason=end_turn', () => {
      const jsonlPath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2024-01-01T00:00:00Z', sessionId: 's1' }),
        JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', model: 'claude' }, timestamp: '2024-01-01T00:00:05Z', sessionId: 's1' }),
      ].join('\n') + '\n');

      const state = watcher.coldStartScan(jsonlPath);
      expect(state).toBe('idle');
    });

    it('returns executing when last assistant has stop_reason=tool_use', () => {
      const jsonlPath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' }, sessionId: 's1' }),
      ].join('\n') + '\n');

      const state = watcher.coldStartScan(jsonlPath);
      expect(state).toBe('executing');
    });

    it('returns thinking when last message is user type', () => {
      const jsonlPath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'do something' }, sessionId: 's1' }),
      ].join('\n') + '\n');

      const state = watcher.coldStartScan(jsonlPath);
      expect(state).toBe('thinking');
    });

    it('returns idle for empty file', () => {
      const jsonlPath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, '');
      const state = watcher.coldStartScan(jsonlPath);
      expect(state).toBe('idle');
    });

    it('returns idle for nonexistent file', () => {
      const state = watcher.coldStartScan(path.join(tmpDir, 'nonexistent.jsonl'));
      expect(state).toBe('idle');
    });
  });

  describe('watch', () => {
    it('emits jsonl-event when new lines are appended', async () => {
      const jsonlPath = path.join(tmpDir, 'live.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const events: any[] = [];
      watcher.on('jsonl-event', (e) => events.push(e));
      watcher.watch('s1', jsonlPath);

      // Append a line
      await new Promise(r => setTimeout(r, 100));
      fs.appendFileSync(jsonlPath, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'test' },
        sessionId: 's1',
      }) + '\n');

      // Wait for fs.watch to fire
      await new Promise(r => setTimeout(r, 500));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].sessionId).toBe('s1');
      expect(events[0].parsed.type).toBe('user');
    });

    it('ignores incomplete last line', async () => {
      const jsonlPath = path.join(tmpDir, 'live.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const events: any[] = [];
      watcher.on('jsonl-event', (e) => events.push(e));
      watcher.watch('s1', jsonlPath);

      await new Promise(r => setTimeout(r, 100));
      // Write incomplete line (no newline)
      fs.appendFileSync(jsonlPath, '{"type":"user"');

      await new Promise(r => setTimeout(r, 500));
      expect(events.length).toBe(0);
    });
  });

  describe('unwatch', () => {
    it('stops emitting events after unwatch', async () => {
      const jsonlPath = path.join(tmpDir, 'live.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const events: any[] = [];
      watcher.on('jsonl-event', (e) => events.push(e));
      watcher.watch('s1', jsonlPath);
      watcher.unwatch('s1');

      await new Promise(r => setTimeout(r, 100));
      fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', sessionId: 's1' }) + '\n');
      await new Promise(r => setTimeout(r, 500));

      expect(events.length).toBe(0);
    });
  });
});
