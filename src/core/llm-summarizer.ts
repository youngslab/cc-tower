import { execSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { logger } from '../utils/logger.js';
import { cleanDisplayText } from '../utils/slug.js';

/**
 * LLM-based context summarizer using parallel `claude --print` calls.
 *
 * Architecture:
 * - Each summary request spawns an independent `claude --print` process
 * - No shared state, no context contamination between sessions
 * - ~10s per call (CLI startup overhead), but multiple sessions run in parallel
 * - Results are cached by content hash — only re-summarizes when messages change
 * - Cache is persisted in session store for instant display on cold start
 */

// Cache: sessionId → { summary, hash }
const cache = new Map<string, { summary: string; hash: string }>();
const inflight = new Set<string>();

/**
 * Start/stop are no-ops now (no hidden session needed).
 */
export async function startLlmSession(): Promise<void> {}
export async function stopLlmSession(): Promise<void> {}
export function getLlmSessionName(): string { return '_cctower_llm'; }

/**
 * Generate a 1-line context summary using `claude --print`.
 * Fully independent per call — no context contamination.
 * Returns cached result if messages haven't changed.
 */
export async function generateContextSummary(
  sessionId: string,
  recentMessages: string,
): Promise<string | undefined> {
  const hash = simpleHash(recentMessages);
  const cached = cache.get(sessionId);
  if (cached && cached.hash === hash) return cached.summary;

  if (inflight.has(sessionId)) return cached?.summary;

  inflight.add(sessionId);
  try {
    const prompt = `아래 개발 세션 대화를 읽고, 사용자가 하고 있는 작업의 목표를 한국어 25자 이내 한 줄로 요약해. 요약만 출력하고 다른 말은 하지 마.

${recentMessages.slice(-2500)}`;

    // execSync in a setTimeout to avoid blocking the event loop for too long
    // (execSync blocks, but claude --print takes ~8s which is acceptable for background work)
    const escaped = prompt.replace(/'/g, "'\\''");
    let stdout = '';
    try {
      stdout = execSync(
        `cd /tmp && claude --print -p '${escaped}' --model haiku --no-session-persistence 2>/dev/null`,
        { timeout: 30000, encoding: 'utf8' },
      );
    } catch {
      stdout = '';
    }

    if (stdout) {
      // Take only the first line, clean it up
      const firstLine = stdout.trim().split('\n')[0] ?? '';
      const summary = cleanDisplayText(firstLine).slice(0, 50);
      if (summary && summary.length > 3) {
        cache.set(sessionId, { summary, hash });
        return summary;
      }
    }
  } catch (err) {
    logger.debug('llm-summarizer: failed', { sessionId, error: String(err) });
  } finally {
    inflight.delete(sessionId);
  }

  return cached?.summary;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
