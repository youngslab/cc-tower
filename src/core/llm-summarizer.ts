import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { cleanDisplayText } from '../utils/slug.js';

/**
 * LLM-based context summarizer using parallel `claude --print` calls.
 *
 * Architecture:
 * - Each summary request spawns an independent `claude --print` via `sh -c`
 * - Fully async (spawn, not execSync) — does NOT block the event loop / UI
 * - No shared state, no context contamination between sessions
 * - ~8-10s per call (CLI startup), but parallel calls complete together
 * - Cache by content hash + persist in session store for instant cold start
 */

// Cache: sessionId → { summary, hash }
const cache = new Map<string, { summary: string; hash: string }>();
const inflight = new Set<string>();

export async function startLlmSession(): Promise<void> {}
export async function stopLlmSession(): Promise<void> {}
export function getLlmSessionName(): string { return '_cctower_llm'; }

/**
 * Generate a 1-line context summary using `claude --print`.
 * Fully async + non-blocking. Returns cached result if messages unchanged.
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
    const prompt = `Read the dev session conversation below. Summarize the user's goal in one line (max 30 words). Use the same language the user is using. Output ONLY the summary, nothing else.\n\n${recentMessages.slice(-2500)}`;

    const stdout = await runClaude(prompt);

    if (stdout) {
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

/**
 * Spawn `claude --print` via `sh -c` — fully async, non-blocking.
 */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd /tmp && claude --print -p '${escaped}' --model haiku --no-session-persistence 2>/dev/null`;

    const child = spawn('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      resolve('');
    }, 30000);

    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
