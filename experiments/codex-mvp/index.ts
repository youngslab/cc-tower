#!/usr/bin/env node
import { execa } from 'execa';
import { discoverLiveCodexSessions } from './discover.js';
import type { CodexMvpSession } from './types.js';

function usage(): never {
  console.error(`Usage:
  npm run codex:mvp -- list [--json]
  npm run codex:mvp -- go <pane|pid|sessionId|cwd-substring>
  npm run codex:mvp -- send <pane|pid|sessionId|cwd-substring> <message...>

This is a standalone Codex MVP probe. It only targets local tmux panes.`);
  process.exit(2);
}

function formatRow(session: CodexMvpSession): string {
  const pane = (session.paneId ?? '—').padEnd(6);
  const pid = String(session.pid).padEnd(8);
  const project = session.projectName.padEnd(22).slice(0, 22);
  const launch = session.launchKind.padEnd(7);
  return `${pane}${pid}${project}${launch}${session.cwd}`;
}

function matchesTarget(session: CodexMvpSession, target: string): boolean {
  return session.paneId === target
    || String(session.pid) === target
    || session.sessionId === target
    || session.cwd.includes(target);
}

function resolveTarget(sessions: CodexMvpSession[], target: string): CodexMvpSession {
  const matches = sessions.filter((session) => matchesTarget(session, target));
  if (matches.length === 0) {
    throw new Error(`No Codex session matches ${JSON.stringify(target)}`);
  }
  if (matches.length > 1) {
    const labels = matches.map((session) => `${session.paneId ?? 'no-pane'} ${session.pid} ${session.cwd}`).join('\n  ');
    throw new Error(`Ambiguous target ${JSON.stringify(target)}. Matches:\n  ${labels}`);
  }
  const match = matches[0]!;
  if (!match.paneId) {
    throw new Error(`Matched Codex session ${match.sessionId} but no tmux pane was found`);
  }
  return match;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') usage();

  const sessions = await discoverLiveCodexSessions();

  if (command === 'list') {
    if (args.includes('--json')) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('No local interactive Codex sessions found.');
      return;
    }
    console.log('PANE  PID     PROJECT               LAUNCH CWD');
    for (const session of sessions) console.log(formatRow(session));
    return;
  }

  if (command === 'go') {
    const [target] = args;
    if (!target) usage();
    const session = resolveTarget(sessions, target);
    await execa('tmux', ['switch-client', '-t', session.paneId!], { stdio: 'inherit' });
    return;
  }

  if (command === 'send') {
    const [target, ...messageParts] = args;
    if (!target || messageParts.length === 0) usage();
    const session = resolveTarget(sessions, target);
    await execa('tmux', ['send-keys', '-t', session.paneId!, messageParts.join(' '), 'Enter'], { stdio: 'inherit' });
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
