/**
 * Generic session info shape returned by detectors. Identical shape to
 * `SessionInfo` in `src/core/discovery.ts` — kept here without a shared
 * interface (2-instances rule).
 */
export interface ClaudeSessionInfo {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    host?: string;
    sshTarget?: string;
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
export declare function isHeadlessSession(sessionsDir: string, pid: number): boolean;
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
export declare function parseSessionFile(filePath: string): Promise<ClaudeSessionInfo | null>;
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
export declare function scanProcesses(claudeDir: string, usedSessionIdsByCwd: (cwd: string, pid: number) => Set<string>): ClaudeSessionInfo[];
