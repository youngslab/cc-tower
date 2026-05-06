import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
export const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
export const RECOMMENDED = {
    ControlMaster: 'auto',
    ControlPath: '~/.ssh/cm-%r@%h:%p',
    ControlPersist: '10m',
};
/**
 * Very simple ssh config parser.
 * - Recognizes 'Host xxx' block starts
 * - Options within a block are case-insensitive keys
 * - Does not handle Include directives (read-only diagnostic only)
 * - Ignores comment lines (#) and blank lines
 */
export function parseSshConfig(content) {
    const blocks = [];
    let current = null;
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        // Skip blank lines and comments
        if (!line || line.startsWith('#'))
            continue;
        const hostMatch = line.match(/^Host\s+(.+)$/i);
        if (hostMatch) {
            if (current)
                blocks.push(current);
            current = { host: hostMatch[1].trim(), options: {} };
            continue;
        }
        if (current) {
            // Option line: key value (separated by whitespace or =)
            const optMatch = line.match(/^(\S+)\s*[= \t]\s*(.+)$/);
            if (optMatch) {
                // Normalize key to canonical casing
                const rawKey = optMatch[1];
                const value = optMatch[2].trim();
                // Use canonical casing if it matches a RECOMMENDED key (case-insensitive)
                const canonicalKey = Object.keys(RECOMMENDED).find(k => k.toLowerCase() === rawKey.toLowerCase()) ?? rawKey;
                current.options[canonicalKey] = value;
            }
        }
    }
    if (current)
        blocks.push(current);
    return blocks;
}
function formatRecommended() {
    return [
        '  Host *',
        ...Object.entries(RECOMMENDED).map(([k, v]) => `    ${k} ${v}`),
    ].join('\n');
}
/**
 * Check SSH ControlMaster configuration for a given host (or all hosts).
 * Returns { ok, report } — never modifies ~/.ssh/config.
 */
export function checkSsh(targetHost, sshConfigPath = SSH_CONFIG_PATH) {
    if (!fs.existsSync(sshConfigPath)) {
        return {
            ok: false,
            report: [
                `~/.ssh/config not found.`,
                ``,
                `To enable ControlMaster, create ~/.ssh/config with:`,
                formatRecommended(),
            ].join('\n'),
        };
    }
    const content = fs.readFileSync(sshConfigPath, 'utf8');
    const blocks = parseSshConfig(content);
    if (blocks.length === 0) {
        return {
            ok: false,
            report: [
                `~/.ssh/config exists but has no Host blocks.`,
                ``,
                `Recommended configuration:`,
                formatRecommended(),
            ].join('\n'),
        };
    }
    // Select blocks to report
    let targetBlocks;
    if (targetHost) {
        // Exact match first, then wildcard fallback
        const exact = blocks.filter(b => b.host === targetHost);
        const wildcard = blocks.filter(b => b.host === '*');
        targetBlocks = exact.length > 0 ? [...exact, ...wildcard] : wildcard;
        if (targetBlocks.length === 0) {
            targetBlocks = blocks; // show all if nothing found
        }
    }
    else {
        targetBlocks = blocks;
    }
    const lines = [];
    let allOk = true;
    for (const block of targetBlocks) {
        lines.push(`Host ${block.host}`);
        for (const [key, recommended] of Object.entries(RECOMMENDED)) {
            const actual = block.options[key];
            if (actual !== undefined) {
                const mark = actual === recommended ? '✓' : '~';
                if (actual !== recommended)
                    allOk = false;
                lines.push(`  ${key.padEnd(20)} ${actual.padEnd(30)} ${mark}${actual !== recommended ? ` (recommended: ${recommended})` : ''}`);
            }
            else {
                allOk = false;
                lines.push(`  ${key.padEnd(20)} ${'(missing)'.padEnd(30)} ✗  recommended: ${recommended}`);
            }
        }
        // Show other options in the block
        for (const [key, value] of Object.entries(block.options)) {
            if (!(key in RECOMMENDED)) {
                lines.push(`  ${key.padEnd(20)} ${value}`);
            }
        }
        lines.push('');
    }
    if (!allOk) {
        lines.push(`To enable ControlMaster for the relevant host(s), add to ~/.ssh/config:`);
        lines.push(formatRecommended());
    }
    return { ok: allOk, report: lines.join('\n').trimEnd() };
}
//# sourceMappingURL=check-ssh.js.map