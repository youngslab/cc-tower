import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

/**
 * Execute a command on a remote host via SSH.
 * All SSH operations go through this helper for future ControlMaster support.
 */
export function sshExec(
  sshTarget: string,
  command: string,
  opts?: { timeout?: number; sshOptions?: string; commandPrefix?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = opts?.timeout ?? 10000;
    const sshArgs = ['ssh'];

    // Add custom SSH options if provided
    if (opts?.sshOptions) {
      sshArgs.push(...opts.sshOptions.split(/\s+/));
    }

    // Common options: no TTY allocation, batch mode (no password prompts)
    sshArgs.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5');

    // When a command prefix is provided, wrap: prefix sh -c 'command'
    // e.g., docker exec devenv sh -c 'cat ~/.claude/sessions/*.json'
    let remoteCommand: string;
    if (opts?.commandPrefix) {
      const innerEscaped = command.replace(/'/g, "'\\''");
      remoteCommand = `${opts.commandPrefix} sh -c '${innerEscaped}'`;
    } else {
      remoteCommand = command;
    }

    // Quote the remote command so globs/redirects run on the remote shell, not locally
    const escaped = remoteCommand.replace(/'/g, "'\\''");
    sshArgs.push(sshTarget, `'${escaped}'`);

    const child = spawn('sh', ['-c', sshArgs.join(' ')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`SSH timeout after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`SSH exit code ${code}: ${stderr.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Check if SSH connection to host works.
 */
export async function sshPing(sshTarget: string, sshOptions?: string): Promise<boolean> {
  try {
    await sshExec(sshTarget, 'echo ok', { timeout: 5000, sshOptions });
    return true;
  } catch {
    return false;
  }
}
