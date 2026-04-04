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
import { logger, setTuiMode } from './utils/logger.js';
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
        execSync('tmux has-session -t claude-cc-tower 2>/dev/null', { stdio: 'ignore' });
        sessionExists = true;
      } catch {
        sessionExists = false;
      }
      if (sessionExists) {
        const child = spawn('tmux', ['attach', '-t', 'claude-cc-tower'], { stdio: 'inherit' });
        child.on('close', (code) => process.exit(code ?? 0));
        child.on('error', () => process.exit(1));
      } else {
        // Re-launch in tmux. Use the resolved entry script path with npx tsx.
        const cwd = process.cwd();
        const entryScript = path.resolve(import.meta.dirname, '..', 'src', 'index.tsx');
        const usesTsx = fs.existsSync(entryScript);
        const args = usesTsx
          ? ['new-session', '-s', 'claude-cc-tower', '-c', cwd, '--', 'npx', 'tsx', entryScript]
          : ['new-session', '-s', 'claude-cc-tower', '-c', cwd, '--', ...process.argv];
        const child = spawn('tmux', args, { stdio: 'inherit' });
        child.on('close', (code) => process.exit(code ?? 0));
        child.on('error', () => process.exit(1));
      }
      return;
    }

    setTuiMode(true);
    const tower = new Tower();
    try {
      await tower.start();
    } catch (err: any) {
      if (err?.message?.includes('already running')) {
        // Another instance is running — try to attach to its tmux session
        console.error('cc-tower is already running.');
        try {
          // Read tmux session name from lock file (line 2)
          const lockPath = path.join(os.homedir(), '.config', 'cc-tower', 'tower.lock');
          const lockLines = fs.readFileSync(lockPath, 'utf8').trim().split('\n');
          const sessionName = lockLines[1]?.trim() || '';
          if (!sessionName) throw new Error('session not found');
          console.error(`Switching to ${sessionName}...`);
          const child = process.env['TMUX']
            ? spawn('tmux', ['switch-client', '-t', sessionName], { stdio: 'inherit' })
            : spawn('tmux', ['attach', '-t', sessionName], { stdio: 'inherit' });
          child.on('close', (code) => process.exit(code ?? 0));
          return;
        } catch {
          console.error('No tmux session found. Kill the existing instance first.');
          process.exit(1);
        }
      }
      throw err;
    }

    // Redirect React/ink console warnings to logger (prevents TUI corruption)
    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;
    console.error = (...args: unknown[]) => logger.error('console.error: ' + args.map(a => a instanceof Error ? a.stack ?? String(a) : String(a)).join(' '));
    console.warn = (...args: unknown[]) => logger.warn('console.warn: ' + args.map(String).join(' '));

    // Enter alternate screen (like vim/htop)
    process.stdout.write('\x1b[?1049h'); // enter alt screen
    process.stdout.write('\x1b[H');      // move cursor to top-left

    const { waitUntilExit } = render(React.createElement(App, { tower }));

    await waitUntilExit();

    // Restore console
    console.error = origConsoleError;
    console.warn = origConsoleWarn;

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

// Inspect — debug session summary vs actual JSONL content (no tower needed)
program
  .command('inspect <session>')
  .option('-n <lines>', 'Number of recent messages to show', '10')
  .action(async (sessionArg: string, opts: { n: string }) => {
    const { parseJsonlLine } = await import('./utils/jsonl-parser.js');
    const { cwdToSlug } = await import('./utils/slug.js');

    // Read state.json directly (no tower startup)
    const statePath = path.join(os.homedir(), '.config', 'cc-tower', 'state.json');
    if (!fs.existsSync(statePath)) {
      console.log('No state.json found. Run cc-tower first.');
      process.exit(1);
    }
    const rawState = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const stateData = (rawState.sessions ?? rawState) as Record<string, Record<string, unknown>>;

    // Find matching session by id, label, projectName, or goalSummary
    const q = sessionArg.toLowerCase();
    const match = Object.entries(stateData).find(([id, s]) =>
      id.startsWith(sessionArg) ||
      ((s.label as string) ?? '').toLowerCase().includes(q) ||
      ((s.projectName as string) ?? '').toLowerCase().includes(q) ||
      ((s.goalSummary as string) ?? '').toLowerCase().includes(q)
    );
    if (!match) {
      console.log(`Session not found: ${sessionArg}`);
      console.log('Available sessions:');
      for (const [id, s] of Object.entries(stateData)) {
        const name = (s.label as string) || (s.projectName as string) || (s.goalSummary as string)?.slice(0, 40) || '(no label)';
        console.log(`  ${id.slice(0, 12)}  ${name}`);
      }
      process.exit(1);
    }

    const [sessionId, s] = match;

    // 1. Show stored summary data
    console.log('═══ Stored Summary ═══');
    console.log(`  Label:            ${(s.label as string) ?? '(none)'}`);
    console.log(`  Goal:             ${(s.goalSummary as string) ?? '(none)'}`);
    console.log(`  Context:          ${(s.contextSummary as string) ?? '(none)'}`);
    console.log(`  Next Steps:       ${(s.nextSteps as string) ?? '(none)'}`);
    console.log(`  Session ID:       ${sessionId}`);
    console.log(`  CWD:              ${(s.cwd as string) ?? '(none)'}`);

    // 2. Find cwd from session files or state
    let cwd = s.cwd as string | undefined;
    if (!cwd) {
      // Look up in ~/.claude/sessions/*.json
      const sessDir = path.join(os.homedir(), '.claude', 'sessions');
      if (fs.existsSync(sessDir)) {
        for (const f of fs.readdirSync(sessDir)) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
            if (d.sessionId === sessionId) { cwd = d.cwd; break; }
          } catch {}
        }
      }
    }
    if (!cwd) {
      console.log('\n  (no cwd — cannot locate JSONL)');
      process.exit(0);
    }
    const claudeDir = path.join(os.homedir(), '.claude');
    const slug = cwdToSlug(cwd);
    const projectDir = path.join(claudeDir, 'projects', slug);
    let jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);

    // Fallback to most recently modified JSONL if exact match doesn't exist
    if (!fs.existsSync(jsonlPath)) {
      try {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          jsonlPath = path.join(projectDir, files[0]!.name);
          console.log(`  (exact JSONL not found, using latest: ${files[0]!.name})`);
        }
      } catch {}
    }

    console.log(`\n═══ JSONL: ${jsonlPath} ═══`);
    if (!fs.existsSync(jsonlPath)) {
      console.log('  (file not found)');
      process.exit(0);
    }

    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const limit = parseInt(opts.n) || 10;
    const recent = lines.slice(-limit * 5);
    const messages: { type: string; text: string; ts: string }[] = [];
    for (const line of recent) {
      const parsed = parseJsonlLine(line);
      if (!parsed) continue;
      if (parsed.type === 'user' && parsed.userContent) {
        messages.push({ type: 'USER', text: parsed.userContent.slice(0, 200), ts: parsed.timestamp ?? '' });
      } else if (parsed.type === 'assistant' && parsed.assistantText) {
        messages.push({ type: 'ASST', text: parsed.assistantText.slice(0, 200), ts: parsed.timestamp ?? '' });
      } else if (parsed.type === 'assistant' && parsed.toolName) {
        messages.push({ type: 'TOOL', text: `${parsed.toolName}(${parsed.toolInput ?? ''})`, ts: parsed.timestamp ?? '' });
      } else if (parsed.type === 'custom-title' && parsed.customTitle) {
        messages.push({ type: 'TITLE', text: parsed.customTitle, ts: parsed.timestamp ?? '' });
      }
    }
    const shown = messages.slice(-limit);
    if (shown.length === 0) {
      console.log('  (no messages found)');
    } else {
      for (const m of shown) {
        const ts = m.ts ? m.ts.slice(11, 19) : '';
        console.log(`  [${ts}] ${m.type}: ${m.text}`);
      }
    }
    process.exit(0);
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
      tower.store.updateBySessionId(s.sessionId, { label: name });
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
      tower.store.updateBySessionId(s.sessionId, { tags });
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

// ps — snapshot of current state from running instance (or state.json fallback)
program
  .command('ps')
  .option('--json', 'Output as JSON')
  .description('Show current session state from the running Tower instance')
  .action(async (opts) => {
    const net = await import('node:net');
    const socketPath = `${process.env['XDG_RUNTIME_DIR'] ?? '/tmp'}/cc-tower.sock`;

    const queryRunning = (): Promise<any[] | null> =>
      new Promise((resolve) => {
        const client = net.createConnection(socketPath, () => {
          client.write(JSON.stringify({ event: 'query' }) + '\n');
          client.end();
        });
        let data = '';
        client.on('data', (chunk) => { data += chunk.toString(); });
        client.on('end', () => {
          try { resolve(JSON.parse(data.trim())); }
          catch { resolve(null); }
        });
        client.on('error', () => resolve(null));
        setTimeout(() => { client.destroy(); resolve(null); }, 2000);
      });

    let sessions = await queryRunning();
    let source = 'live';

    if (!sessions) {
      // Fallback: read state.json directly
      const statePath = path.join(os.homedir(), '.local', 'share', 'cc-tower', 'state.json');
      const altStatePath = path.join(os.homedir(), '.config', 'cc-tower', 'state.json');
      const stateFile = fs.existsSync(statePath) ? statePath : fs.existsSync(altStatePath) ? altStatePath : null;
      if (stateFile) {
        try {
          const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const data = (raw.sessions ?? raw) as Record<string, Record<string, unknown>>;
          sessions = Object.entries(data).map(([id, s]) => ({ sessionId: id, ...s }));
          source = 'state.json (Tower not running)';
        } catch { sessions = []; }
      } else {
        sessions = [];
        source = 'no data';
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ source, sessions }, null, 2));
      return;
    }

    console.log(`source: ${source}  (${sessions.length} sessions)`);
    if (sessions.length === 0) {
      console.log('No sessions');
      return;
    }
    console.log('');
    const cols = [
      { h: 'SID',    w: 8  },
      { h: 'LABEL',  w: 18 },
      { h: 'STATUS', w: 11 },
      { h: 'CWD',    w: 30 },
      { h: 'GOAL',   w: 0  },
    ];
    console.log(cols.map((c, i) => c.w ? c.h.padEnd(c.w) : c.h).join(''));
    console.log('─'.repeat(80));
    for (const s of sessions as any[]) {
      const sid   = (s.sessionId ?? '').slice(0, 8).padEnd(8);
      const label = ((s.label ?? s.projectName ?? '')).slice(0, 16).padEnd(18);
      const status = (s.status ?? '?').padEnd(11);
      const cwd   = (s.cwd ?? '').replace(os.homedir(), '~').slice(0, 28).padEnd(30);
      const goal  = (s.goalSummary ?? s.currentTask ?? '').slice(0, 60);
      console.log(`${sid}${label}${status}${cwd}${goal}`);
    }
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
