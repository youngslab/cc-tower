import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { cwdToSlug } from '../utils/slug.js';
export class DiscoveryEngine extends EventEmitter {
    config;
    interval = null;
    known = new Map();
    constructor(config) {
        super();
        this.config = config;
    }
    start() {
        if (this.interval !== null)
            return;
        void this.scanOnce();
        this.interval = setInterval(() => {
            void this.scanOnce();
        }, this.config.scan_interval);
    }
    stop() {
        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    async scanOnce() {
        const sessionsDir = join(this.config.claude_dir, 'sessions');
        let files = [];
        try {
            files = await readdir(sessionsDir);
        }
        catch (err) {
            logger.debug('discovery: could not read sessions dir', { sessionsDir, err: String(err) });
            return [];
        }
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        // If sessions dir is empty, fall back to process scanning
        if (jsonFiles.length === 0) {
            return this.scanProcesses();
        }
        const active = [];
        for (const file of jsonFiles) {
            const filePath = join(sessionsDir, file);
            let info;
            try {
                const raw = await readFile(filePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (!isSessionInfo(parsed)) {
                    logger.debug('discovery: malformed session file', { filePath });
                    continue;
                }
                info = parsed;
            }
            catch (err) {
                logger.debug('discovery: failed to read/parse session file', { filePath, err: String(err) });
                continue;
            }
            const alive = isPidAlive(info.pid);
            if (!alive) {
                if (this.known.has(info.pid)) {
                    const lost = this.known.get(info.pid);
                    this.known.delete(info.pid);
                    this.emit('session-lost', lost);
                    logger.debug('discovery: session-lost (PID dead)', { pid: info.pid });
                }
                continue;
            }
            if (!this.known.has(info.pid)) {
                this.known.set(info.pid, info);
                this.emit('session-found', info);
                logger.debug('discovery: session-found', { pid: info.pid, sessionId: info.sessionId });
            }
            else {
                // Detect sessionId change (e.g., /resume, /clear)
                const prev = this.known.get(info.pid);
                if (prev.sessionId !== info.sessionId) {
                    logger.debug('discovery: session-changed', { pid: info.pid, old: prev.sessionId, new: info.sessionId });
                    this.known.set(info.pid, info);
                    this.emit('session-changed', { prev, next: info });
                }
            }
            active.push(info);
        }
        // Check known PIDs that are no longer in any file
        for (const [pid, session] of this.known) {
            if (!active.find((s) => s.pid === pid)) {
                if (!isPidAlive(pid)) {
                    this.known.delete(pid);
                    this.emit('session-lost', session);
                    logger.debug('discovery: session-lost (no file)', { pid });
                }
            }
        }
        return active;
    }
    /**
     * Fallback: discover Claude sessions by scanning running processes.
     * Used when ~/.claude/sessions/ is empty (Claude Code >= 2.1.77).
     */
    scanProcesses() {
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
                // Only include if we have a matching project directory in claude_dir
                const slug = cwdToSlug(cwd);
                const projectDir = join(this.config.claude_dir, 'projects', slug);
                try {
                    readdirSync(projectDir);
                }
                catch {
                    continue;
                } // no project dir = not a tracked session
                let sessionId = `proc-${pid}`;
                try {
                    const jsonls = readdirSync(projectDir)
                        .filter(f => f.endsWith('.jsonl'))
                        .map(f => { try {
                        return { name: f, mtime: statSync(join(projectDir, f)).mtimeMs };
                    }
                    catch {
                        return { name: f, mtime: 0 };
                    } })
                        .sort((a, b) => b.mtime - a.mtime);
                    if (jsonls.length > 0) {
                        sessionId = jsonls[0].name.replace('.jsonl', '');
                    }
                }
                catch { }
                const info = {
                    pid,
                    sessionId,
                    cwd,
                    startedAt: Date.now(),
                };
                if (!this.known.has(pid)) {
                    this.known.set(pid, info);
                    this.emit('session-found', info);
                    logger.debug('discovery: session-found (process scan)', { pid, cwd });
                }
                active.push(info);
            }
            // Check for dead processes
            for (const [pid, session] of this.known) {
                if (!active.find(s => s.pid === pid) && !isPidAlive(pid)) {
                    this.known.delete(pid);
                    this.emit('session-lost', session);
                }
            }
        }
        catch (err) {
            logger.debug('discovery: process scan failed', { error: String(err) });
        }
        return active;
    }
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isSessionInfo(val) {
    if (typeof val !== 'object' || val === null)
        return false;
    const v = val;
    return (typeof v['pid'] === 'number' &&
        typeof v['sessionId'] === 'string' &&
        typeof v['cwd'] === 'string' &&
        typeof v['startedAt'] === 'number');
}
//# sourceMappingURL=discovery.js.map