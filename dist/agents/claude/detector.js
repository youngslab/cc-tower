import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { cwdToSlug } from '../../utils/slug.js';
/**
 * Validate a parsed session record produced by Claude Code's
 * `~/.claude/sessions/<pid>.json` writer.
 */
function isClaudeSessionInfo(val) {
    if (typeof val !== 'object' || val === null)
        return false;
    const v = val;
    return (typeof v['pid'] === 'number' &&
        typeof v['sessionId'] === 'string' &&
        typeof v['cwd'] === 'string' &&
        typeof v['startedAt'] === 'number');
}
/**
 * Read a `~/.claude/sessions/<pid>.json` file and check whether it
 * represents a headless / SDK-spawned (non-interactive) session that
 * should be ignored for hook attribution.
 *
 * Returns `true` only when the file exists, parses, and explicitly marks
 * itself as a headless subprocess. Any I/O or parse failure → `false`
 * (caller treats unknown shape as "interactive, attribute normally").
 */
export function isHeadlessSession(sessionsDir, pid) {
    try {
        const raw = readFileSync(join(sessionsDir, `${pid}.json`), 'utf8');
        const end = raw.indexOf('}');
        const parsed = JSON.parse(end >= 0 ? raw.slice(0, end + 1) : raw);
        return parsed.entrypoint === 'sdk-cli';
    }
    catch {
        return false;
    }
}
/**
 * Parse a single `~/.claude/sessions/<pid>.json` file to a ClaudeSessionInfo.
 *
 * Returns `null` if:
 *   - The file is missing or malformed
 *   - `entrypoint === 'sdk-cli'` (headless subprocess — not an interactive terminal)
 *   - `cwd` starts with `/tmp` (ephemeral, e.g. LLM summarizer subprocesses)
 *
 * Centralizes Claude-specific filters so the generic discovery loop does
 * not leak knowledge of Claude's session schema.
 */
export async function parseSessionFile(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf8');
    }
    catch (err) {
        logger.debug('claude.detector: failed to read session file', { filePath, err: String(err) });
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // File may have trailing garbage after the JSON object — extract the first object
        const end = raw.indexOf('}');
        if (end === -1) {
            logger.debug('claude.detector: no closing brace in session file', { filePath });
            return null;
        }
        try {
            parsed = JSON.parse(raw.slice(0, end + 1));
        }
        catch (err) {
            logger.debug('claude.detector: failed to parse session file', { filePath, err: String(err) });
            return null;
        }
    }
    if (!isClaudeSessionInfo(parsed)) {
        logger.debug('claude.detector: malformed session file', { filePath });
        return null;
    }
    // Skip sdk-cli sessions (headless subprocesses spawned by user code, not interactive terminals)
    if (parsed['entrypoint'] === 'sdk-cli') {
        logger.debug('claude.detector: skipping sdk-cli session', { filePath });
        return null;
    }
    // Skip /tmp sessions (ephemeral subprocesses, LLM summarizer, etc.)
    if (parsed.cwd.startsWith('/tmp')) {
        logger.debug('claude.detector: skipping /tmp session', { filePath, cwd: parsed.cwd });
        return null;
    }
    return parsed;
}
/**
 * Fallback: discover Claude sessions by scanning running processes when
 * `~/.claude/sessions/` is empty (Claude Code >= 2.1.77 stopped writing pid.json).
 *
 * Strategy:
 *   1. `ps -eo pid,comm | grep claude` to find all live `claude` processes
 *   2. Read `/proc/<pid>/cwd` and `/proc/<pid>/environ` for sessionId
 *   3. Match against known JSONL files under `<claudeDir>/projects/<slug>/`
 *
 * `usedSessionIdsByCwd` lets the caller hide JSONL filenames already claimed
 * by another known PID (so two Claude processes in the same directory don't
 * collide on the same session).
 */
export function scanProcesses(claudeDir, usedSessionIdsByCwd) {
    const active = [];
    try {
        // Find all 'claude' processes with a CWD
        const out = execSync("ps -eo pid,comm | grep '^[[:space:]]*[0-9].*claude$' | awk '{print $1}'", { encoding: 'utf8', timeout: 5000 }).trim();
        if (!out)
            return active;
        for (const pidStr of out.split('\n')) {
            const pid = parseInt(pidStr.trim());
            if (isNaN(pid))
                continue;
            // Get CWD from /proc
            let cwd;
            try {
                cwd = readlinkSync(`/proc/${pid}/cwd`);
            }
            catch {
                continue;
            }
            if (!cwd)
                continue;
            // Skip temporary/ephemeral claude processes (e.g., claude --print from /tmp)
            if (cwd === '/tmp' || cwd.startsWith('/tmp/'))
                continue;
            // Only include if we have a matching project directory in claudeDir
            const slug = cwdToSlug(cwd);
            const projectDir = join(claudeDir, 'projects', slug);
            try {
                readdirSync(projectDir);
            }
            catch {
                continue;
            } // no project dir = not a tracked session
            let sessionId = `proc-${pid}`;
            // 1. Try to get CLAUDE_SESSION_ID from process environment (highest priority)
            try {
                const environPath = `/proc/${pid}/environ`;
                const environData = readFileSync(environPath, 'utf-8');
                const environ = environData.split('\0');
                const claudeSessionIdEntry = environ.find(entry => entry.startsWith('CLAUDE_SESSION_ID='));
                if (claudeSessionIdEntry) {
                    sessionId = claudeSessionIdEntry.replace('CLAUDE_SESSION_ID=', '');
                }
            }
            catch { }
            // 2. Fallback: use JSONL filename if CLAUDE_SESSION_ID not found
            // Skip JSONLs already claimed by another known session (same CWD, different PID)
            if (sessionId.startsWith('proc-')) {
                try {
                    const usedSessionIds = usedSessionIdsByCwd(cwd, pid);
                    const jsonls = readdirSync(projectDir)
                        .filter(f => f.endsWith('.jsonl'))
                        .map(f => { try {
                        return { name: f, mtime: statSync(join(projectDir, f)).mtimeMs };
                    }
                    catch {
                        return { name: f, mtime: 0 };
                    } })
                        .sort((a, b) => b.mtime - a.mtime);
                    for (const j of jsonls) {
                        const candidate = j.name.replace('.jsonl', '');
                        if (!usedSessionIds.has(candidate)) {
                            sessionId = candidate;
                            break;
                        }
                    }
                }
                catch { }
            }
            const info = {
                pid,
                sessionId,
                cwd,
                startedAt: Date.now(),
            };
            active.push(info);
        }
    }
    catch (err) {
        logger.debug('claude.detector: process scan failed', { error: String(err) });
    }
    return active;
}
//# sourceMappingURL=detector.js.map