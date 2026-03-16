import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * LLM-based context summarizer.
 * Calls claude --print with haiku for cheap, fast 1-line summaries.
 * Fully async — never blocks the UI.
 */

// Cache: sessionId → { summary, lastTurnHash }
const cache = new Map<string, { summary: string; hash: string }>();

// In-flight requests to avoid duplicate calls
const inflight = new Set<string>();

/**
 * Generate a 1-line context summary for a session using LLM.
 * Returns cached result if the turn hasn't changed.
 * Returns undefined if still loading or error.
 */
export async function generateContextSummary(
  sessionId: string,
  recentMessages: string,
): Promise<string | undefined> {
  // Hash the input to detect changes
  const hash = simpleHash(recentMessages);
  const cached = cache.get(sessionId);
  if (cached && cached.hash === hash) return cached.summary;

  // Skip if already in-flight
  if (inflight.has(sessionId)) return cached?.summary;

  inflight.add(sessionId);
  try {
    const prompt = `You are summarizing a coding session. Given the recent conversation below, write a single Korean sentence (max 40 chars) describing WHAT the user is working on overall. Focus on the goal, not the details. No quotes, no periods.

Recent messages:
${recentMessages.slice(-3000)}

Summary:`;

    const { stdout } = await execFileAsync('claude', [
      '--print',
      '-p', prompt,
      '--model', 'haiku',
      '--no-session-persistence',
    ], { timeout: 10000 }).catch(() => ({ stdout: '' }));

    const summary = stdout?.trim().slice(0, 60);
    if (summary) {
      cache.set(sessionId, { summary, hash });
      return summary;
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
