/**
 * popmux doctor — diagnose and optionally repair corrupted state.json entries.
 *
 * Detects:
 *  - orphaned_convid: lastConversationId set but no JSONL exists for it
 *  - cross_cwd_convid: lastConversationId != lastSessionId and convId JSONL lives in
 *    a different cwd than the sessionId JSONL (cross-pane contamination signal)
 *  - dangling_session_ref: lastSessionId references a sessions[] entry with no cwd
 *
 * With --apply: backs up state.json.YYYYMMDD.bak then removes only the offending
 * lastConversationId fields. NEVER deletes entries with favorite === true.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function findJsonlForConvId(claudeDir, convId) {
    const projectsDir = path.join(claudeDir, 'projects');
    let entries;
    try {
        entries = fs.readdirSync(projectsDir);
    }
    catch {
        return null;
    }
    for (const slug of entries) {
        const candidate = path.join(projectsDir, slug, `${convId}.jsonl`);
        if (fs.existsSync(candidate))
            return { path: candidate, slug };
    }
    return null;
}
export function runDoctor(opts = {}) {
    const statePath = opts.statePath ?? path.join(os.homedir(), '.config', 'popmux', 'state.json');
    const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
    // Default: dry-run unless --apply is explicitly set.
    const apply = opts.apply === true && opts.dryRun !== true;
    let raw;
    try {
        raw = fs.readFileSync(statePath, 'utf8');
    }
    catch (err) {
        throw new Error(`Cannot read state file at ${statePath}: ${String(err)}`);
    }
    const state = JSON.parse(raw);
    if (!state.instances)
        state.instances = {};
    if (!state.sessions)
        state.sessions = {};
    const findings = [];
    for (const [identity, inst] of Object.entries(state.instances)) {
        const favorite = inst.favorite === true;
        if (inst.lastConversationId) {
            const convFile = findJsonlForConvId(claudeDir, inst.lastConversationId);
            if (!convFile) {
                findings.push({
                    identity,
                    kind: 'orphaned_convid',
                    detail: `lastConversationId=${inst.lastConversationId.slice(0, 12)} has no JSONL on disk`,
                    favorite,
                });
            }
            else if (inst.lastSessionId && inst.lastConversationId !== inst.lastSessionId) {
                // Cross-cwd check: compare the slug that holds the convId JSONL to the
                // cwd recorded in sessions[lastSessionId].
                const sessEntry = state.sessions[inst.lastSessionId];
                const sessCwd = sessEntry?.cwd;
                const sidFile = findJsonlForConvId(claudeDir, inst.lastSessionId);
                const sidSlug = sidFile?.slug;
                if (sessCwd && sidSlug && convFile.slug !== sidSlug) {
                    findings.push({
                        identity,
                        kind: 'cross_cwd_convid',
                        detail: `lastConversationId lives in slug=${convFile.slug} but lastSessionId lives in slug=${sidSlug}`,
                        favorite,
                    });
                }
            }
        }
        if (inst.lastSessionId) {
            const sessEntry = state.sessions[inst.lastSessionId];
            if (sessEntry && !sessEntry.cwd) {
                findings.push({
                    identity,
                    kind: 'dangling_session_ref',
                    detail: `sessions[${inst.lastSessionId.slice(0, 12)}] has no cwd`,
                    favorite,
                });
            }
        }
    }
    let backupPath;
    let applied = false;
    if (apply && findings.length > 0) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        backupPath = `${statePath}.${stamp}.bak`;
        fs.writeFileSync(backupPath, raw);
        // Apply: remove lastConversationId from affected entries.
        // NEVER delete an entry whose favorite === true.
        for (const f of findings) {
            const inst = state.instances[f.identity];
            if (!inst)
                continue;
            if (f.kind === 'orphaned_convid' || f.kind === 'cross_cwd_convid') {
                delete inst.lastConversationId;
            }
            // dangling_session_ref is informational — do not auto-mutate (no clear fix).
        }
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        applied = true;
    }
    return { findings, backupPath, applied };
}
export function printDoctorReport(report) {
    if (report.findings.length === 0) {
        console.log('popmux doctor: no issues detected.');
        return;
    }
    console.log(`popmux doctor: found ${report.findings.length} issue(s)`);
    console.log('');
    console.log('IDENTITY            KIND                   FAV  DETAIL');
    console.log('------------------- ---------------------- ---- -----------------------------------');
    for (const f of report.findings) {
        const id = f.identity.padEnd(19).slice(0, 19);
        const kind = f.kind.padEnd(22);
        const fav = f.favorite ? 'YES ' : '    ';
        console.log(`${id} ${kind} ${fav} ${f.detail}`);
    }
    console.log('');
    if (report.applied) {
        console.log(`Applied repairs. Backup: ${report.backupPath}`);
    }
    else if (report.backupPath === undefined) {
        console.log('Dry-run: pass --apply to remove offending lastConversationId fields.');
        console.log('Note: favorite entries are NEVER deleted (their lastConversationId may still be cleared).');
    }
}
//# sourceMappingURL=doctor.js.map