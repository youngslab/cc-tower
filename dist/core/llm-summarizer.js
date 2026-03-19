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
const cache = new Map();
const inflight = new Set();
// Goal cache: sessionId → { summary, hash }
const goalCache = new Map();
const goalInflight = new Set();
// Next steps cache: sessionId → { summary, hash }
const nextStepsCache = new Map();
const nextStepsInflight = new Set();
export async function startLlmSession() { }
export async function stopLlmSession() { }
export function getLlmSessionName() { return '_cctower_llm'; }
/**
 * Generate a 1-line context summary using `claude --print`.
 * Fully async + non-blocking. Returns cached result if messages unchanged.
 */
export async function generateContextSummary(sessionId, recentMessages) {
    const hash = simpleHash(recentMessages);
    const cached = cache.get(sessionId);
    if (cached && cached.hash === hash)
        return cached.summary;
    if (inflight.has(sessionId))
        return cached?.summary;
    inflight.add(sessionId);
    try {
        const prompt = `Read the recent dev session messages below. Summarize what the user is currently working on RIGHT NOW in one line (max 50 words). Use the same language the user is using. Output ONLY the summary.\n\n${recentMessages.slice(-2500)}`;
        const stdout = await runClaude(prompt);
        if (stdout) {
            const firstLine = stdout.trim().split('\n')[0] ?? '';
            const summary = cleanDisplayText(firstLine).slice(0, 120);
            if (summary && summary.length > 3) {
                cache.set(sessionId, { summary, hash });
                return summary;
            }
        }
    }
    catch (err) {
        logger.info('llm-summarizer: failed', { sessionId, error: String(err) });
    }
    finally {
        inflight.delete(sessionId);
    }
    return cached?.summary;
}
/**
 * Generate a 1-line goal summary using `claude --print`.
 * Generated once from early messages. Returns cached result if messages unchanged.
 */
export async function generateGoalSummary(sessionId, earlyMessages) {
    const hash = simpleHash(earlyMessages);
    const cached = goalCache.get(sessionId);
    if (cached && cached.hash === hash)
        return cached.summary;
    if (goalInflight.has(sessionId))
        return cached?.summary;
    goalInflight.add(sessionId);
    try {
        const prompt = `Read the dev session conversation below. Summarize the user's overall goal/objective for this session in one line (max 50 words). Use the same language the user is using. Output ONLY the summary.\n\n${earlyMessages.slice(0, 2500)}`;
        const stdout = await runClaude(prompt);
        if (stdout) {
            const firstLine = stdout.trim().split('\n')[0] ?? '';
            const summary = cleanDisplayText(firstLine).slice(0, 120);
            if (summary && summary.length > 3) {
                goalCache.set(sessionId, { summary, hash });
                return summary;
            }
        }
    }
    catch (err) {
        logger.info('llm-summarizer: goal summary failed', { sessionId, error: String(err) });
    }
    finally {
        goalInflight.delete(sessionId);
    }
    return cached?.summary;
}
/**
 * Generate a next-steps suggestion using `claude --print`.
 * Called on idle transition. Returns undefined if no clear next step.
 */
export async function generateNextSteps(sessionId, recentMessages) {
    const hash = simpleHash(recentMessages);
    const cached = nextStepsCache.get(sessionId);
    if (cached && cached.hash === hash)
        return cached.summary;
    if (nextStepsInflight.has(sessionId))
        return cached?.summary;
    nextStepsInflight.add(sessionId);
    try {
        const prompt = `Analyze this dev session and suggest what the user should do next. If the work is fully complete with no obvious next step, output "NONE". Max 30 words. Use the same language the user is using. Output ONLY the suggestion.\n\n${recentMessages.slice(-2500)}`;
        const stdout = await runClaude(prompt);
        if (stdout) {
            const firstLine = stdout.trim().split('\n')[0] ?? '';
            const suggestion = cleanDisplayText(firstLine).slice(0, 120);
            if (!suggestion || suggestion.length < 3 || suggestion.toUpperCase() === 'NONE') {
                return undefined;
            }
            nextStepsCache.set(sessionId, { summary: suggestion, hash });
            return suggestion;
        }
    }
    catch (err) {
        logger.info('llm-summarizer: next steps failed', { sessionId, error: String(err) });
    }
    finally {
        nextStepsInflight.delete(sessionId);
    }
    return cached?.summary;
}
/**
 * Spawn `claude --print` via `sh -c` — fully async, non-blocking.
 */
function runClaude(prompt) {
    return new Promise((resolve) => {
        const child = spawn('claude', ['--print', '--model', 'haiku', '--no-session-persistence'], {
            cwd: '/tmp',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.write(prompt);
        child.stdin.end();
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
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
function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}
//# sourceMappingURL=llm-summarizer.js.map