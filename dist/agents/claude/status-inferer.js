import fs from 'node:fs';
import { parseJsonlLine } from '../../utils/jsonl-parser.js';
import { cleanDisplayText, isInternalMessage } from '../../utils/slug.js';
/**
 * Scan a Claude Code JSONL file to determine the current session state at cold start.
 * Reads the last meaningful message to infer state.
 */
export function coldStartScan(jsonlPath) {
    let content;
    try {
        const stat = fs.statSync(jsonlPath);
        const readSize = Math.min(stat.size, 65536); // last 64KB is enough
        if (readSize < stat.size) {
            const fd = fs.openSync(jsonlPath, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
            fs.closeSync(fd);
            content = buf.toString('utf8');
        }
        else {
            content = fs.readFileSync(jsonlPath, 'utf8');
        }
    }
    catch {
        return 'idle';
    }
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0)
        return 'idle';
    // Walk backwards to find last state-determining message.
    // Priority order:
    // 1. system turn_duration/stop_hook_summary → idle (turn definitively ended)
    // 2. assistant end_turn → idle
    // 3. assistant tool_use → executing
    // 4. assistant stop_reason=null → thinking (streaming)
    // `user` messages alone are unreliable — internal commands create entries without turns.
    let sawUser = false;
    let sawTurnEnd = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonlLine(lines[i]);
        if (!parsed)
            continue;
        // system turn_duration, stop_hook_summary, or local_command = turn is over / idle
        if (parsed.type === 'system' && (parsed.systemSubtype === 'turn_duration' || parsed.systemSubtype === 'stop_hook_summary' || parsed.systemSubtype === 'local_command')) {
            sawTurnEnd = true;
            continue;
        }
        if (parsed.type === 'assistant') {
            if (parsed.stopReason === 'end_turn')
                return 'idle';
            if (sawTurnEnd)
                return 'idle'; // turn ended even if stop_reason is None/tool_use
            if (parsed.stopReason === 'tool_use')
                return 'executing';
            if (parsed.stopReason === null)
                return 'thinking';
            continue;
        }
        if (parsed.type === 'user') {
            if (sawTurnEnd)
                return 'idle'; // turn ended after this user message
            sawUser = true;
            continue;
        }
    }
    // If we only found user messages with no assistant, likely thinking
    // But if no messages at all, idle
    return sawUser ? 'thinking' : 'idle';
}
/**
 * Extract the last user message content from a JSONL file (for cold start currentTask).
 */
export function coldStartLastTask(jsonlPath) {
    let content;
    try {
        const stat = fs.statSync(jsonlPath);
        const readSize = Math.min(stat.size, 65536); // last 64KB is enough
        if (readSize < stat.size) {
            const fd = fs.openSync(jsonlPath, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
            fs.closeSync(fd);
            content = buf.toString('utf8');
        }
        else {
            content = fs.readFileSync(jsonlPath, 'utf8');
        }
    }
    catch {
        return undefined;
    }
    const lines = content.split('\n').filter(l => l.trim());
    // Walk backwards to find last real user message (skip internal commands)
    for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonlLine(lines[i]);
        if (!parsed)
            continue;
        if (parsed.type === 'user' && parsed.userContent) {
            const text = parsed.userContent.trim();
            if (isInternalMessage(text))
                continue;
            return cleanDisplayText(text).slice(0, 80);
        }
    }
    return undefined;
}
/**
 * Extract the latest custom-title (/rename) from a JSONL file.
 */
export function coldStartCustomTitle(jsonlPath) {
    try {
        // custom-title lines are tiny (~100 bytes) and rare (1-2 per session).
        // Read the entire file and grep for "custom-title" to avoid missing entries
        // that fall in the gap between a small head and a tail-only read.
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.split('\n').filter(l => l.includes('custom-title'));
        // Walk backwards — latest rename wins
        for (let i = lines.length - 1; i >= 0; i--) {
            const parsed = parseJsonlLine(lines[i]);
            if (parsed?.type === 'custom-title' && parsed.customTitle) {
                return parsed.customTitle;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=status-inferer.js.map