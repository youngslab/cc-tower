import { spawn } from 'node:child_process';
import { sshExec } from './exec.js';
import path from 'node:path';
/**
 * Install hook plugin on a remote host via SCP + SSH.
 */
export async function installRemoteHooks(sshTarget, sshOptions) {
    const localHooksDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'hooks');
    try {
        // 1. Create remote directory
        await sshExec(sshTarget, 'mkdir -p ~/.claude/plugins/cc-tower/hooks', { sshOptions });
        // 2. SCP hooks files
        const scpFiles = `scp ${localHooksDir}/hooks.json ${localHooksDir}/cc-tower-hook.sh ${sshTarget}:~/.claude/plugins/cc-tower/hooks/`;
        await runShell(scpFiles);
        // 3. SCP plugin.json
        await runShell(`scp ${localHooksDir}/plugin.json ${sshTarget}:~/.claude/plugins/cc-tower/`);
        // 4. Make hook script executable
        await sshExec(sshTarget, 'chmod +x ~/.claude/plugins/cc-tower/hooks/cc-tower-hook.sh', { sshOptions });
        // 5. Verify
        const verify = await sshExec(sshTarget, 'ls ~/.claude/plugins/cc-tower/hooks/hooks.json', { sshOptions });
        if (verify.trim()) {
            return { success: true, message: `Hook plugin installed on ${sshTarget}` };
        }
        return { success: false, message: 'Verification failed: hooks.json not found on remote' };
    }
    catch (err) {
        return { success: false, message: `Failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
function runShell(cmd) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        child.on('error', reject);
    });
}
//# sourceMappingURL=install-remote-hooks.js.map