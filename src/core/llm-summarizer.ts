import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import { parseJsonlLine } from '../utils/jsonl-parser.js';
import { cleanDisplayText } from '../utils/slug.js';

const execFileAsync = promisify(execFile);

/**
 * LLM-based context summarizer using a persistent hidden tmux Claude session.
 *
 * Architecture:
 * - Starts a hidden tmux session `_cctower_llm` with `claude` (interactive)
 * - Sends prompts via `tmux send-keys`
 * - Monitors the session's JSONL for responses (stop_reason=end_turn)
 * - First query is slow (~10s, Claude startup), subsequent queries are fast (~1-2s)
 */

const LLM_SESSION = '_cctower_llm';
const LLM_CWD = '/tmp/cc-tower-llm';

// Cache: sessionId → { summary, hash }
const cache = new Map<string, { summary: string; hash: string }>();
const inflight = new Set<string>();

let llmReady = false;
let llmSessionId: string | null = null;
let llmJsonlPath: string | null = null;
let startingUp = false;

/**
 * Start the hidden Claude session for LLM summarization.
 * Call once at Tower startup. Non-blocking — session boots in background.
 */
export async function startLlmSession(): Promise<void> {
  if (startingUp || llmReady) return;
  startingUp = true;

  try {
    // Ensure cwd exists
    fs.mkdirSync(LLM_CWD, { recursive: true });

    // Kill stale session
    try {
      await execFileAsync('tmux', ['kill-session', '-t', LLM_SESSION]);
    } catch {}

    // Start hidden session with claude (skip trust prompt + permissions)
    await execFileAsync('tmux', [
      'new-session', '-d', '-s', LLM_SESSION, '-c', LLM_CWD,
      'claude', '--model', 'haiku', '--dangerously-skip-permissions',
    ]);

    logger.debug('llm-summarizer: session started, waiting for boot...');

    // Wait for Claude to boot (poll for session file)
    const started = await waitForClaudeBoot(15000);
    if (started) {
      // Set role: instruct Claude to only return short summaries
      await execFileAsync('tmux', [
        'send-keys', '-t', LLM_SESSION,
        '너는 요약 봇이야. [요약]으로 시작하는 메시지가 오면, 해당 내용의 작업 목표를 한국어 25자 이내 한 줄로만 답해. 설명이나 질문 없이 요약만. 이해했으면 OK만 답해.',
        'Enter',
      ]);
      // Wait for OK response
      await sleep(5000);
      llmReady = true;
      logger.debug('llm-summarizer: ready', { sessionId: llmSessionId });
    } else {
      logger.debug('llm-summarizer: boot timeout, will retry later');
    }
  } catch (err) {
    logger.debug('llm-summarizer: failed to start', { error: String(err) });
  } finally {
    startingUp = false;
  }
}

/**
 * Stop the hidden Claude session.
 */
export async function stopLlmSession(): Promise<void> {
  llmReady = false;
  llmSessionId = null;
  llmJsonlPath = null;
  try {
    await execFileAsync('tmux', ['kill-session', '-t', LLM_SESSION]);
  } catch {}
}

/**
 * Get the tmux session name used for LLM (for filtering in discovery).
 */
export function getLlmSessionName(): string {
  return LLM_SESSION;
}

/**
 * Generate a 1-line context summary using the persistent Claude session.
 */
export async function generateContextSummary(
  sessionId: string,
  recentMessages: string,
): Promise<string | undefined> {
  const hash = simpleHash(recentMessages);
  const cached = cache.get(sessionId);
  if (cached && cached.hash === hash) return cached.summary;

  if (!llmReady || !llmJsonlPath) return cached?.summary;
  if (inflight.has(sessionId)) return cached?.summary;

  inflight.add(sessionId);
  try {
    const prompt = `[요약] ${recentMessages.slice(-1500)}`;

    // Record JSONL size before sending
    const sizeBefore = getFileSize(llmJsonlPath);

    // Send prompt to hidden session
    await execFileAsync('tmux', [
      'send-keys', '-t', LLM_SESSION, prompt.replace(/\n/g, ' '), 'Enter',
    ]);

    // Wait for response (poll JSONL for new end_turn)
    const response = await waitForResponse(llmJsonlPath, sizeBefore, 8000);
    if (response) {
      const summary = cleanDisplayText(response).slice(0, 60);
      if (summary && summary.length > 2) {
        cache.set(sessionId, { summary, hash });
        return summary;
      }
    }
  } catch (err) {
    logger.debug('llm-summarizer: query failed', { sessionId, error: String(err) });
  } finally {
    inflight.delete(sessionId);
  }

  return cached?.summary;
}

// --- Internal helpers ---

async function waitForClaudeBoot(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');

  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (data.cwd === LLM_CWD) {
          llmSessionId = data.sessionId;
          const slug = LLM_CWD.replace(/\//g, '-');
          llmJsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, `${data.sessionId}.jsonl`);
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function waitForResponse(jsonlPath: string, offsetBefore: number, timeoutMs: number): Promise<string | undefined> {
  const start = Date.now();
  let lastText = '';

  while (Date.now() - start < timeoutMs) {
    await sleep(300);
    const currentSize = getFileSize(jsonlPath);
    if (currentSize <= offsetBefore) continue;

    try {
      const fd = fs.openSync(jsonlPath, 'r');
      const length = currentSize - offsetBefore;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offsetBefore);
      fs.closeSync(fd);

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const parsed = parseJsonlLine(line);
        if (!parsed || parsed.type !== 'assistant') continue;

        // Collect text from streaming messages
        if (parsed.assistantText) {
          lastText = parsed.assistantText;
        }

        // end_turn = response complete
        if (parsed.stopReason === 'end_turn') {
          return lastText || parsed.assistantText || undefined;
        }
      }
    } catch {}
  }

  return lastText || undefined;
}

function getFileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
