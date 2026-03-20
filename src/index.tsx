#!/usr/bin/env node
import { program } from 'commander';
import React from 'react';
import { render } from 'ink';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tower } from './core/tower.js';
import { App } from './ui/App.js';
import { tmux } from './tmux/commands.js';
import { setTuiMode } from './utils/logger.js';
import { loadConfig } from './config/loader.js';

program
  .name('cc-tower')
  .description('Claude Code Session Control Tower')
  .version('0.1.0');

// Default: TUI dashboard
program
  .action(async () => {
    // If not inside tmux, launch cc-tower inside a tmux session
    if (!process.env['TMUX']) {
      // Check if session already exists
      let sessionExists = false;
      try {
        execSync('tmux has-session -t cc-tower 2>/dev/null', { stdio: 'ignore' });
        sessionExists = true;
      } catch {
        sessionExists = false;
      }
      if (sessionExists) {
        const child = spawn('tmux', ['attach', '-t', 'cc-tower'], { stdio: 'inherit' });
        child.on('close', (code) => process.exit(code ?? 0));
        child.on('error', () => process.exit(1));
      } else {
        // Re-launch in tmux. Use the resolved entry script path with npx tsx.
        const cwd = process.cwd();
        const entryScript = path.resolve(import.meta.dirname, '..', 'src', 'index.tsx');
        const usesTsx = fs.existsSync(entryScript);
        const args = usesTsx
          ? ['new-session', '-s', 'cc-tower', '-c', cwd, '--', 'npx', 'tsx', entryScript]
          : ['new-session', '-s', 'cc-tower', '-c', cwd, '--', ...process.argv];
        const child = spawn('tmux', args, { stdio: 'inherit' });
        child.on('close', (code) => process.exit(code ?? 0));
        child.on('error', () => process.exit(1));
      }
      return;
    }

    setTuiMode(true);
    const tower = new Tower();
    await tower.start();

    // Enter alternate screen (like vim/htop)
    process.stdout.write('\x1b[?1049h'); // enter alt screen
    process.stdout.write('\x1b[H');      // move cursor to top-left

    const { waitUntilExit } = render(React.createElement(App, { tower }));

    await waitUntilExit();

    // Leave alternate screen (restore original terminal content)
    process.stdout.write('\x1b[?1049l');

    // Force exit — pending claude --print processes may keep Node alive
    process.exit(0);
  });

// List sessions
program
  .command('list')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      if (sessions.length === 0) {
        console.log('No active sessions');
      } else {
        console.log('PANE  LABEL             STATUS    TASK');
        for (const s of sessions) {
          const pane = (s.paneId ?? '—').padEnd(6);
          const label = (s.label ?? s.projectName).slice(0, 16).padEnd(18);
          const status = s.status.toUpperCase().padEnd(10);
          const task = s.currentTask ?? '';
          console.log(`${pane}${label}${status}${task}`);
        }
      }
    }
    await tower.stop();
  });

// Status
program
  .command('status [session]')
  .action(async (sessionArg) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    if (sessionArg) {
      const s = sessions.find(s => s.sessionId.startsWith(sessionArg) || s.label === sessionArg || s.paneId === sessionArg);
      if (s) {
        console.log(`${s.label ?? s.projectName}: ${s.status} (${s.paneId ?? 'no pane'})`);
      } else {
        console.log(`Session not found: ${sessionArg}`);
      }
    } else {
      const active = sessions.filter(s => s.status !== 'dead').length;
      const idle = sessions.filter(s => s.status === 'idle').length;
      console.log(`${sessions.length} sessions (${active} active, ${idle} idle)`);
    }
    await tower.stop();
  });

// Send command
program
  .command('send <session> <message>')
  .action(async (sessionArg, message) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    const s = sessions.find(s => s.sessionId.startsWith(sessionArg) || s.label === sessionArg || s.paneId === sessionArg);
    if (!s) {
      console.log(`Session not found: ${sessionArg}`);
    } else if (s.sshTarget) {
      const escaped = message.replace(/'/g, "'\\''");
      const cmd = `ssh ${s.sshTarget} "tmux send-keys -t ${s.paneId} '${escaped}' Enter"`;
      await new Promise<void>((resolve) => {
        const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });
      console.log(`Sent to ${s.label ?? s.projectName} (${s.sshTarget}:${s.paneId})`);
    } else if (!s.paneId) {
      console.log('Session has no tmux pane');
    } else {
      await tmux.sendKeys(s.paneId, message);
      console.log(`Sent to ${s.label ?? s.projectName} (${s.paneId})`);
    }
    await tower.stop();
  });

// Peek
program
  .command('peek <session>')
  .action(async (sessionArg: string) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    const s = sessions.find(s => s.sessionId.startsWith(sessionArg) || s.label === sessionArg || s.paneId === sessionArg);
    if (!s) {
      console.log(`Session not found: ${sessionArg}`);
    } else if (s.sshTarget) {
      await tmux.displayPopup({
        width: '80%', height: '80%',
        title: ` ${s.label ? `[${s.label}] ` : ''}${s.projectName} (${s.host})${s.goalSummary ? ` — ${s.goalSummary.slice(0, 60)}` : ''} | prefix+d to close `,
        command: `ssh -t ${s.sshTarget} "tmux attach"`,
        closeOnExit: true,
      });
    } else if (!s.paneId) {
      console.log('Session has no tmux pane');
    } else {
      const panes = await tmux.listPanes();
      const targetPane = panes.find(p => p.paneId === s.paneId);
      if (targetPane) {
        await tmux.displayPopup({
          width: '80%', height: '80%',
          title: ` ${s.label ? `[${s.label}] ` : ''}${s.projectName} (${s.paneId})${s.goalSummary ? ` — ${s.goalSummary.slice(0, 60)}` : ''} | prefix+d to close `,
          command: `tmux attach -t ${targetPane.sessionName} \\; select-window -t :${targetPane.windowIndex}`,
          closeOnExit: true,
        });
      }
    }
    await tower.stop();
  });

// Watch pane manually
program
  .command('watch <paneId>')
  .action(async (paneId: string) => {
    console.log(`Watching pane ${paneId} (auto-discovery will pick it up)`);
  });

// Install hooks
program
  .command('install-hooks')
  .option('--remote <host>', 'Install hooks on a remote host')
  .action(async (opts: { remote?: string }) => {
    if (opts.remote) {
      // Remote install
      const config = loadConfig();
      const hostConfig = config.hosts.find(h => h.name === opts.remote);
      if (!hostConfig) {
        console.log(`Host not found in config: ${opts.remote}`);
        console.log('Configure hosts in ~/.config/cc-tower/config.yaml');
        process.exit(1);
      }
      const { installRemoteHooks } = await import('./ssh/install-remote-hooks.js');
      const result = await installRemoteHooks(hostConfig.ssh, hostConfig.ssh_options);
      console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
    } else {
      // Local install
      const pluginDir = path.join(os.homedir(), '.claude', 'plugins', 'cc-tower');
      const hooksDir = path.join(pluginDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      // Copy hooks files from our package
      const srcHooksDir = path.resolve(import.meta.dirname, '..', 'hooks');
      for (const file of ['hooks.json', 'plugin.json', 'cc-tower-hook.sh']) {
        const src = path.join(srcHooksDir, file);
        const dest = path.join(file === 'plugin.json' ? pluginDir : hooksDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          if (file.endsWith('.sh')) {
            fs.chmodSync(dest, 0o755);
          }
        }
      }

      console.log(`✓ Hook plugin installed at ${pluginDir}`);
      console.log('  New Claude Code sessions will report to cc-tower.');
      console.log('  Already running sessions use JSONL fallback.');
    }
  });

// Label
program
  .command('label <session> <name>')
  .action(async (sessionArg, name) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    const s = sessions.find(s => s.sessionId.startsWith(sessionArg) || s.paneId === sessionArg);
    if (s) {
      tower.store.update(s.sessionId, { label: name });
      tower.store.persist();
      console.log(`Labeled ${s.paneId ?? s.sessionId.slice(0, 8)} as "${name}"`);
    } else {
      console.log(`Session not found: ${sessionArg}`);
    }
    await tower.stop();
  });

// Tag
program
  .command('tag <session> <tags...>')
  .action(async (sessionArg, tags) => {
    const tower = new Tower(undefined, { skipHooks: true });
    await tower.start();
    const sessions = tower.store.getAll();
    const s = sessions.find(s => s.sessionId.startsWith(sessionArg) || s.label === sessionArg || s.paneId === sessionArg);
    if (s) {
      tower.store.update(s.sessionId, { tags });
      tower.store.persist();
      console.log(`Tagged ${s.label ?? s.sessionId.slice(0, 8)}: ${tags.join(', ')}`);
    } else {
      console.log(`Session not found: ${sessionArg}`);
    }
    await tower.stop();
  });

// Config
program
  .command('config')
  .action(() => {
    const configPath = path.join(os.homedir(), '.config', 'cc-tower', 'config.yaml');
    const editor = process.env['EDITOR'] ?? 'vi';
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '# cc-tower configuration\n# See PRD for available options\n');
    }
    execSync(`${JSON.stringify(editor)} ${JSON.stringify(configPath)}`, { stdio: 'inherit' });
  });

// Internal: hook CLI fallback
program
  .command('hook <event>')
  .action(async (event: string) => {
    const net = await import('node:net');
    const socketPath = `${process.env['XDG_RUNTIME_DIR'] ?? '/tmp'}/cc-tower.sock`;
    const payload = JSON.stringify({
      event,
      sid: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
      cwd: process.cwd(),
      ts: Date.now(),
    });
    const client = net.createConnection(socketPath, () => {
      client.write(payload + '\n');
      client.end();
    });
    client.on('error', () => {});
  });

program.parse();
