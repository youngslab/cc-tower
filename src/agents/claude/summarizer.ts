import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { cleanDisplayText } from '../../utils/slug.js';

/**
 * LLM-based context summarizer using a single combined `claude --print` call.
 *
 * Architecture:
 * - generateAllSummaries() issues ONE claude --print call for goal+context+nextSteps
 * - Fully async (spawn, not execSync) — does NOT block the event loop / UI
 * - No shared state, no context contamination between sessions
 * - Cache by sha256 content hash + persist in session store for instant cold start
 */

export interface AllSummaries {
  goal?: string;
  context?: string;
  nextSteps?: string;
}

// Combined cache: sessionId → { result, hash }
const allCache = new Map<string, { result: AllSummaries; hash: string }>();
const allInflight = new Set<string>();

/** Clear all cached summaries for a session so next call regenerates. */
export function clearSummaryCache(sessionId: string): void {
  allCache.delete(sessionId);
}

export async function startLlmSession(): Promise<void> {}
export async function stopLlmSession(): Promise<void> {}
export function getLlmSessionName(): string { return '_popmux_llm'; }

/**
 * Generate goal + context + nextSteps in ONE `claude --print` call.
 * earlyMessages = first N turns (for goal detection)
 * recentMessages = last N turns (for context + nextSteps)
 * Returns cached result if content hash unchanged.
 */
export async function generateAllSummaries(
  sessionId: string,
  earlyMessages: string,
  recentMessages: string,
): Promise<AllSummaries | undefined> {
  const hash = contentHash(earlyMessages + '\x00' + recentMessages);
  const cached = allCache.get(sessionId);
  if (cached && cached.hash === hash) return cached.result;

  if (allInflight.has(sessionId)) return cached?.result;

  allInflight.add(sessionId);
  try {
    const prompt =
      `Read this dev session. Output ONLY a valid JSON object with these exact keys:\n` +
      `{"goal":"one-line user intent (max 50 words)","context":"one-line what was accomplished (max 50 words)","nextSteps":"what to do next or NONE (max 30 words)"}\n` +
      `Use the same language as the user. No explanation, no markdown, just the JSON.\n\n` +
      `=== EARLY MESSAGES ===\n${earlyMessages.slice(0, 2000)}\n\n` +
      `=== RECENT MESSAGES ===\n${recentMessages.slice(-2000)}`;

    const stdout = await runClaude(prompt);
    if (!stdout) return cached?.result;

    const result = parseAllSummariesOutput(stdout);
    if (result) {
      allCache.set(sessionId, { result, hash });
      return result;
    }
  } catch (err) {
    logger.info('llm-summarizer: generateAllSummaries failed', { sessionId, error: String(err) });
  } finally {
    allInflight.delete(sessionId);
  }

  return cached?.result;
}

function parseAllSummariesOutput(raw: string): AllSummaries | undefined {
  // Extract JSON from output (handle markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return undefined;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const result: AllSummaries = {};
    if (typeof parsed['goal'] === 'string') {
      const g = cleanDisplayText(parsed['goal']).slice(0, 120);
      if (g.length > 3) result.goal = g;
    }
    if (typeof parsed['context'] === 'string') {
      const c = cleanDisplayText(parsed['context']).slice(0, 120);
      if (c.length > 3) result.context = c;
    }
    if (typeof parsed['nextSteps'] === 'string') {
      const n = cleanDisplayText(parsed['nextSteps']).slice(0, 120);
      if (n.length > 3 && n.toUpperCase() !== 'NONE') result.nextSteps = n;
    }
    return (result.goal || result.context) ? result : undefined;
  } catch {
    return undefined;
  }
}

// Keep individual exports for remote SSH path (used in tower.ts remote helpers)
export async function generateContextSummary(sessionId: string, recentMessages: string): Promise<string | undefined> {
  const res = await generateAllSummaries(sessionId, recentMessages, recentMessages);
  return res?.context;
}

export async function generateGoalSummary(sessionId: string, earlyMessages: string): Promise<string | undefined> {
  const res = await generateAllSummaries(sessionId, earlyMessages, earlyMessages);
  return res?.goal;
}

export async function generateNextSteps(sessionId: string, recentMessages: string): Promise<string | undefined> {
  const res = await generateAllSummaries(sessionId, recentMessages, recentMessages);
  return res?.nextSteps;
}

/**
 * Spawn `claude --print` — fully async, non-blocking.
 * stderr is kept separate to avoid polluting the output.
 */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--print', '--model', 'haiku', '--no-session-persistence'], {
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    // stderr intentionally discarded — do not mix into output

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

function contentHash(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}
