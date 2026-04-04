import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Config } from '../config/defaults.js';
import { loadConfig } from '../config/loader.js';
import { DiscoveryEngine, SessionInfo } from './discovery.js';
import { SessionStore, Session, sessionIdentity } from './session-store.js';
import { HookReceiver } from './hook-receiver.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { ProcessMonitor } from './process-monitor.js';
import { SessionStateMachine, InputEvent } from './state-machine.js';
import { Summarizer } from './summarizer.js';
import { Notifier } from './notifier.js';
import { mapPidToPane } from '../tmux/pane-mapper.js';
import { isHeadlessProcess, isPidAlive, getPpid } from '../utils/pid-resolver.js';
import { tmux } from '../tmux/commands.js';
import { cwdToSlug, cleanDisplayText, isInternalMessage } from '../utils/slug.js';
import { generateContextSummary, generateGoalSummary, generateNextSteps, clearSummaryCache, startLlmSession, stopLlmSession, getLlmSessionName } from './llm-summarizer.js';
import { logger } from '../utils/logger.js';
import { parseJsonlLine } from '../utils/jsonl-parser.js';
import { ConnectionManager } from '../ssh/connection-manager.js';
import { RemoteDiscovery, RemoteSessionInfo } from '../ssh/remote-discovery.js';
import { remoteReadJsonlTail, remoteListPanes, RemoteHostConfig } from '../ssh/remote-commands.js';
import { sshExec } from '../ssh/exec.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class Tower extends EventEmitter {
  config: Config;
  store: SessionStore;
  discovery: DiscoveryEngine;
  hookReceiver: HookReceiver;
  jsonlWatcher: JsonlWatcher;
  processMonitor: ProcessMonitor;
  summarizer: Summarizer;
  notifier: Notifier;
  private stateMachines: Map<string, SessionStateMachine> = new Map();
  private remoteStateMachines: Map<string, SessionStateMachine> = new Map();
  private hookSidToIdentity: Map<string, string> = new Map(); // CLAUDE_SESSION_ID → identity (paneId ?? String(pid))
  private jsonlPaths: Map<string, string> = new Map(); // sessionId → jsonlPath
  private stopping = false;
  private connectionManager!: ConnectionManager;
  private remoteDiscovery: RemoteDiscovery | null = null;
  private remotePollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  private skipHooks: boolean;

  constructor(config?: Config, opts?: { skipHooks?: boolean }) {
    super();
    this.config = config ?? loadConfig();
    this.skipHooks = opts?.skipHooks ?? false;

    const persistPath = path.join(os.homedir(), '.config', 'cc-tower', 'state.json');
    const socketPath = `${process.env['XDG_RUNTIME_DIR'] ?? '/tmp'}/cc-tower.sock`;

    this.store = new SessionStore(persistPath);
    this.discovery = new DiscoveryEngine({
      scan_interval: this.config.discovery.scan_interval,
      claude_dir: this.config.discovery.claude_dir.replace('~', os.homedir()),
    });
    this.hookReceiver = new HookReceiver(socketPath);
    this.jsonlWatcher = new JsonlWatcher();
    this.processMonitor = new ProcessMonitor();
    this.summarizer = new Summarizer();
    this.notifier = new Notifier(this.config.notifications, this.store);
  }

  private lockFd: number | null = null;

  private acquireLock(): boolean {
    const lockPath = path.join(os.homedir(), '.config', 'cc-tower', 'tower.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      this.lockFd = fs.openSync(lockPath, 'wx');
      const tmuxSession = process.env['TMUX'] ? this.getTmuxSessionName() : '';
      fs.writeFileSync(lockPath, `${process.pid}\n${tmuxSession}\n`);
      return true;
    } catch {
      // File exists — check if PID is still alive
      try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim().split('\n')[0]);
        if (!isNaN(pid)) {
          try { process.kill(pid, 0); return false; } catch { /* stale lock */ }
        }
        // Stale lock — reclaim
        fs.unlinkSync(lockPath);
        this.lockFd = fs.openSync(lockPath, 'wx');
        const tmuxSession = process.env['TMUX'] ? this.getTmuxSessionName() : '';
        fs.writeFileSync(lockPath, `${process.pid}\n${tmuxSession}\n`);
        return true;
      } catch {
        return false;
      }
    }
  }

  private getTmuxSessionName(): string {
    try {
      return execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 3000 }).trim();
    } catch { return ''; }
  }

  private releaseLock(): void {
    const lockPath = path.join(os.homedir(), '.config', 'cc-tower', 'tower.lock');
    try {
      if (this.lockFd !== null) fs.closeSync(this.lockFd);
      fs.unlinkSync(lockPath);
    } catch {}
    this.lockFd = null;
  }

  async start(): Promise<void> {
    // Read version + git commit for startup log
    let version = 'unknown';
    let commit = 'unknown';
    try {
      const pkgPath = new URL('../../package.json', import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version ?? 'unknown';
    } catch {}
    try {
      const { execSync } = await import('node:child_process');
      commit = execSync('git rev-parse --short HEAD', { cwd: path.dirname(new URL(import.meta.url).pathname), timeout: 3000 }).toString().trim();
    } catch {}
    logger.info('tower: starting cc-tower', { version, commit, hosts: this.config.hosts.map(h => h.name) });

    // === Single Instance Lock ===
    if (!this.skipHooks && !this.acquireLock()) {
      logger.error('tower: another instance is already running');
      throw new Error('Another cc-tower instance is already running. Kill it first or use the existing one.');
    }
    if (!this.skipHooks) {
      const cleanup = () => this.releaseLock();
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    }

    // === Cold Start Sequence ===
    // 0. Clean up stale peek sessions from previous runs
    try {
      const { execSync } = await import('node:child_process');
      const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
      for (const name of sessions.split('\n')) {
        if (name.startsWith('_cctower_peek_')) {
          try { execSync(`tmux kill-session -t ${name} 2>/dev/null`); } catch {}
        }
      }
    } catch {}

    // 1. Restore user metadata (labels, tags) from disk
    this.store.restore();

    // 2. Start hook receiver (socket bind) — skip for one-shot commands to avoid stealing the TUI's socket
    if (!this.skipHooks) {
      try {
        await this.hookReceiver.start();
        logger.info('tower: hook receiver started');
      } catch (err) {
        logger.warn('tower: hook receiver failed to start, continuing without hooks', { error: String(err) });
      }
    }

    // 3. Scan for active sessions
    const sessions = await this.discovery.scanOnce();
    logger.info('tower: discovered sessions', { count: sessions.length });

    // 4. For each session: resolve pane, cold start JSONL, register (parallel)
    await Promise.all(sessions.map(info => this.registerSession(info)));

    // 5. Wire up hook events
    this.hookReceiver.on('hook-event', (event) => {
      this.handleHookEvent(event);
    });

    // Wire up query events — respond with live session state (used by `cc-tower ps`)
    this.hookReceiver.on('query', (conn: import('node:net').Socket) => {
      try {
        const sessions = this.store.getAll();
        conn.write(JSON.stringify(sessions) + '\n');
      } catch {}
      conn.end();
    });

    // 6. Wire up JSONL events
    this.jsonlWatcher.on('jsonl-event', ({ sessionId, parsed }) => {
      this.handleJsonlEvent(sessionId, parsed);
    });

    // 7. Wire up discovery events for runtime changes
    this.discovery.on('session-found', async (info: SessionInfo) => {
      logger.info('tower: new session found', { pid: info.pid, sessionId: info.sessionId });
      await this.registerSession(info);
    });

    this.discovery.on('session-lost', (info: SessionInfo) => {
      logger.info('tower: session lost', { pid: info.pid, sessionId: info.sessionId });
      this.deregisterSession(info.sessionId);
    });

    this.discovery.on('session-changed', async ({ prev, next }: { prev: SessionInfo; next: SessionInfo }) => {
      const claudeDir = this.config.discovery.claude_dir.replace('~', os.homedir());
      const slug = cwdToSlug(next.cwd);
      const nextJsonl = path.join(claudeDir, 'projects', slug, `${next.sessionId}.jsonl`);
      const isResume = (() => { try { return fs.statSync(nextJsonl).size > 0; } catch { return false; } })();

      logger.info(`tower: session changed (${isResume ? 'resume' : 'clear'})`, { pid: next.pid, old: prev.sessionId, new: next.sessionId });

      // Find session by identity (paneId ?? String(pid)) — same pane, just sessionId changed
      // SessionInfo doesn't carry paneId; look up existing session by prev.sessionId to get paneId
      const prevSession = this.store.getBySessionId(prev.sessionId);
      const identity = prevSession ? sessionIdentity(prevSession) : String(next.pid);
      const session = this.store.get(identity);
      if (!session) {
        logger.warn('tower: session-changed but no session found for identity', { identity, pid: next.pid });
        return;
      }

      // Swap JSONL path (sessionId-keyed map stays sessionId-keyed)
      this.jsonlWatcher.unwatch(prev.sessionId);
      this.jsonlPaths.delete(prev.sessionId);

      // Update sessionId in-place
      // /clear: new sessionId has no meta entry → clean start (label/tags/summaries empty)
      // /resume: explicitly reassociate meta from old sessionId to new sessionId
      if (isResume) {
        this.store.reassociateMeta(prev.sessionId, next.sessionId);
      }
      this.store.update(identity, { sessionId: next.sessionId });

      // Setup new JSONL path
      if (fs.existsSync(nextJsonl) && fs.statSync(nextJsonl).size > 0) {
        this.jsonlPaths.set(next.sessionId, nextJsonl);
        this.jsonlWatcher.watch(next.sessionId, nextJsonl);
      } else {
        // /clear: JSONL not yet created — watch for it
        const projectDir = path.dirname(nextJsonl);
        const watcher = fs.watch(projectDir, (event, filename) => {
          if (filename === `${next.sessionId}.jsonl` && fs.existsSync(nextJsonl) && fs.statSync(nextJsonl).size > 0) {
            this.jsonlPaths.set(next.sessionId, nextJsonl);
            this.jsonlWatcher.watch(next.sessionId, nextJsonl);
            watcher.close();
          }
        });
        setTimeout(() => watcher.close(), 60_000);
      }
    });

    // 8. Start periodic discovery
    this.discovery.start();

    // 9. Trigger initial summary for sessions that are already idle
    for (const session of this.store.getAll()) {
      if (session.status !== 'dead') {
        const identity = sessionIdentity(session);
        const jp = this.jsonlPaths.get(session.sessionId);
        if (jp) {
          void this.refreshGoalSummary(identity, jp);
          if (!session.contextSummary) void this.refreshContextSummary(identity, jp);
          if (!session.nextSteps && session.status === 'idle') void this.refreshNextSteps(identity, jp);
        }
      }
    }

    // 10. Start hidden LLM session (non-blocking, boots in background)
    void startLlmSession();

    // 11. Setup SSH remote hosts (if configured)
    if (this.config.hosts.length > 0) {
      this.connectionManager = new ConnectionManager();
      const socketPath = `${process.env['XDG_RUNTIME_DIR'] ?? '/tmp'}/cc-tower.sock`;

      // Start SSH tunnels for hooks:true hosts
      for (const host of this.config.hosts) {
        if (host.hooks) {
          const success = await this.connectionManager.startTunnel(
            host.name, host.ssh, socketPath, host.ssh_options
          );
          if (!success) {
            logger.warn('tower: SSH tunnel failed, falling back to JSONL polling', { host: host.name });
          }
        }
      }
      this.connectionManager.startHealthCheck(socketPath);

      // Start remote discovery
      const remoteHosts = this.config.hosts.map(h => ({
        name: h.name,
        config: { sshTarget: h.ssh, sshOptions: h.ssh_options, claudeDir: h.claude_dir, commandPrefix: h.command_prefix } as RemoteHostConfig,
      }));
      this.remoteDiscovery = new RemoteDiscovery(remoteHosts);

      this.remoteDiscovery.on('session-found', async (info: RemoteSessionInfo) => {
        logger.info('tower: remote session found', { host: info.host, sessionId: info.sessionId });
        await this.registerRemoteSession(info);
      });

      this.remoteDiscovery.on('session-lost', (info: RemoteSessionInfo) => {
        const key = `${info.host}::${info.sessionId}`;
        logger.info('tower: remote session lost', { host: info.host, sessionId: info.sessionId });
        this.deregisterSession(key);
      });

      this.remoteDiscovery.on('host-offline', (hostName: string) => {
        // Mark all sessions from this host as offline
        for (const session of this.store.getAll()) {
          if (session.host === hostName) {
            this.store.updateBySessionId(session.sessionId, { hostOnline: false });
          }
        }
      });

      this.remoteDiscovery.on('host-online', (hostName: string) => {
        for (const session of this.store.getAll()) {
          if (session.host === hostName) {
            this.store.updateBySessionId(session.sessionId, { hostOnline: true });
          }
        }
      });

      // Pre-populate known so first scan emits session-lost for dead sessions
      // (e.g. after server reboot — PIDs gone but session files persist on disk)
      // Handles both new format (sshTarget persisted) and old format (key prefix only).
      const restoredByKey = new Set<string>();
      for (const session of this.store.getRestoredRemoteSessions()) {
        const rawSessionId = session.sessionId.includes('::')
          ? session.sessionId.split('::').slice(1).join('::')
          : session.sessionId;
        this.remoteDiscovery.addKnown({
          pid: session.pid,
          sessionId: rawSessionId,
          cwd: session.cwd,
          startedAt: session.startedAt,
          host: session.host,
          sshTarget: session.sshTarget,
        });
        restoredByKey.add(session.sessionId);
      }
      // Fallback for old-format state.json: detect remote sessions by "hostName::" key prefix
      const hostConfigMap = new Map(remoteHosts.map(h => [h.name, h.config]));
      for (const key of this.store.getPersistedKeys()) {
        if (restoredByKey.has(key)) continue;
        const sep = key.indexOf('::');
        if (sep === -1) continue;
        const hostName = key.slice(0, sep);
        const rawSessionId = key.slice(sep + 2);
        const hostConfig = hostConfigMap.get(hostName);
        if (!hostConfig) continue;
        this.remoteDiscovery.addKnown({
          pid: 0,
          sessionId: rawSessionId,
          cwd: '',
          startedAt: 0,
          host: hostName,
          sshTarget: hostConfig.sshTarget,
        });
      }
      this.remoteDiscovery.start(5000);
    }

    logger.info('tower: started successfully', { sessions: this.store.getAll().length });
  }


  /** Full refresh: re-scan discovery, re-register session, then regenerate LLM summaries. */
  async refreshSession(sessionId: string): Promise<void> {
    const session = this.store.getBySessionId(sessionId);
    if (!session) return;
    const identity = sessionIdentity(session);
    logger.info('tower: refreshSession called', { sessionId, host: session.host, sshTarget: session.sshTarget });

    // Clear UI immediately
    clearSummaryCache(sessionId);
    this.store.updateMeta(identity, { goalSummary: undefined, contextSummary: undefined, nextSteps: undefined });
    this.store.update(identity, { summaryLoading: true });

    // Re-scan discovery to pick up any changes (new PID, session file changes)
    const discovered = await this.discovery.scanOnce();
    const match = discovered.find(s => s.sessionId === sessionId) ?? discovered.find(s => s.cwd === session.cwd && s.pid === session.pid);

    if (match && match.sessionId !== sessionId) {
      // Session ID changed (e.g., /clear, /resume) — re-register
      logger.info('tower: refresh detected session change', { old: sessionId, new: match.sessionId });
      this.cleanupSession(identity);
      await this.registerSession(match);
      // Migrate metadata — only pass defined values to avoid overwriting with undefined
      const newIdentity = sessionIdentity(match);
      const migrationMeta: Partial<import('./session-store.js').SessionMeta> = {};
      if (session.label !== undefined) migrationMeta.label = session.label;
      if (session.tags !== undefined) migrationMeta.tags = session.tags;
      if (session.favorite !== undefined) { migrationMeta.favorite = session.favorite; migrationMeta.favoritedAt = session.favoritedAt; }
      this.store.updateMeta(newIdentity, migrationMeta);
      this.store.update(newIdentity, { summaryLoading: true });
      const jp = this.jsonlPaths.get(match.sessionId);
      if (jp) {
        void this.refreshGoalSummary(newIdentity, jp);
        void this.refreshContextSummary(newIdentity, jp);
        void this.refreshNextSteps(newIdentity, jp);
      }
    } else if (session.sshTarget) {
      // Remote session — use SSH-based refresh
      const hostConfig = this.config.hosts.find(h => h.name === session.host);
      if (hostConfig) {
        const remoteConfig: RemoteHostConfig = {
          sshTarget: hostConfig.ssh,
          sshOptions: hostConfig.ssh_options,
          claudeDir: hostConfig.claude_dir,
          commandPrefix: hostConfig.command_prefix,
        };
        // Re-check newest remote JSONL
        let jp = this.jsonlPaths.get(sessionId) ?? '';
        try {
          const claudeDir = hostConfig.claude_dir ?? '~/.claude';
          const slug = cwdToSlug(session.cwd);
          const lsOut = await sshExec(hostConfig.ssh, `ls -t ${claudeDir}/projects/${slug}/*.jsonl 2>/dev/null | head -1`, { sshOptions: hostConfig.ssh_options, commandPrefix: hostConfig.command_prefix, timeout: 5000 });
          const newest = lsOut.trim();
          if (newest) {
            jp = newest;
            this.jsonlPaths.set(sessionId, jp);
            logger.info('tower: remote refresh updated JSONL path', { sessionId, newPath: jp });
          }
        } catch {}
        if (jp) {
          void this.refreshAllRemoteSummaries(sessionId, remoteConfig, jp);
        } else {
          this.store.update(sessionId, { summaryLoading: false });
          logger.info('tower: remote refresh skipped, no JSONL', { sessionId });
        }
      }
    } else {
      // Local session — refresh JSONL path and summaries
      const jp = this.jsonlPaths.get(sessionId);
      if (jp) {
        // Re-check newest JSONL
        try {
          const dir = path.dirname(jp);
          const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) {
            const newest = path.join(dir, files[0]!.name);
            if (newest !== jp) {
              this.jsonlPaths.set(sessionId, newest);
              this.jsonlWatcher.unwatch(sessionId);
              this.jsonlWatcher.watch(sessionId, newest);
              logger.info('tower: refresh updated JSONL path', { sessionId, newPath: newest });
            }
          }
        } catch {}

        const updatedJp = this.jsonlPaths.get(sessionId)!;
        void this.refreshGoalSummary(identity, updatedJp);
        void this.refreshContextSummary(identity, updatedJp);
        void this.refreshNextSteps(identity, updatedJp);
      } else {
        // No JSONL available — clear loading state
        this.store.update(identity, { summaryLoading: false });
        logger.info('tower: refresh skipped, no JSONL', { sessionId });
      }
    }
  }

  /**
   * Renames the tmux session containing the given pane to `claude-{projectName}`.
   * Skips if: session already has the correct name, is the Tower's own session,
   * or already belongs to a different project (starts with "claude-" but differs).
   */
  private async ensureTmuxSessionName(paneId: string, projectName: string): Promise<void> {
    const targetName = `claude-${projectName}`;
    try {
      const panes = await tmux.listPanes();
      const pane = panes.find(p => p.paneId === paneId);
      if (!pane) return;
      if (pane.sessionName === targetName) return;
      // Don't rename Tower's own session or sessions already dedicated to another project
      if (pane.sessionName === 'claude-cc-tower') return;
      if (pane.sessionName.startsWith('claude-') && pane.sessionName !== targetName) return;
      await tmux.renameSession(pane.sessionName, targetName);
      logger.info('tower: renamed tmux session', { from: pane.sessionName, to: targetName, paneId });
    } catch (err) {
      logger.debug('tower: could not rename tmux session', { paneId, projectName, error: String(err) });
    }
  }

  /**
   * Called when session-start hook fires for an already-idle session (e.g. /resume).
   * Claude Code does not update sessions/{pid}.json on /resume, so discovery never emits
   * session-changed and the FSM stays idle→idle (no state-change). This method detects
   * whether a newer JSONL exists (= new conversation was resumed) and refreshes summaries.
   */
  private async refreshSessionAfterResume(identity: string): Promise<void> {
    const session = this.store.get(identity);
    if (!session) return;
    const sessionId = session.sessionId;
    const jp = this.jsonlPaths.get(sessionId);
    if (!jp) return;

    try {
      const dir = path.dirname(jp);
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const newest = path.join(dir, files[0]!.name);
        if (newest !== jp) {
          logger.info('tower: resume detected — switching to newer JSONL', { identity, old: path.basename(jp), new: files[0]!.name });
          this.jsonlPaths.set(sessionId, newest);
          this.jsonlWatcher.unwatch(sessionId);
          this.jsonlWatcher.watch(sessionId, newest);
          // Clear stale summaries so they are regenerated from the resumed conversation
          this.store.updateMeta(identity, { goalSummary: undefined, contextSummary: undefined, nextSteps: undefined });
        }
      }
    } catch {}

    const updatedJp = this.jsonlPaths.get(sessionId)!;
    void this.refreshGoalSummary(identity, updatedJp);
    void this.refreshContextSummary(identity, updatedJp);
  }

  private async refreshGoalSummary(identity: string, jsonlPath: string): Promise<void> {
    try {
      const session = this.store.get(identity);
      const sessionId = session?.sessionId ?? identity;
      logger.info('tower: refreshing goal summary', { identity, jsonlPath });
      const earlyMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!earlyMessages) {
        logger.info('tower: no early messages found for goal', { identity });
        this.store.update(identity, { summaryLoading: false });
        return;
      }
      if (earlyMessages.length < 20) {
        logger.info('tower: early messages too short for goal summary', { identity, len: earlyMessages.length });
        return;
      }
      logger.info('tower: calling LLM for goal summary', { identity, msgLen: earlyMessages.length });
      const summary = await generateGoalSummary(sessionId, earlyMessages);
      if (summary) {
        logger.info('tower: goal summary received', { identity, summary });
        this.store.updateMeta(identity, { goalSummary: summary });
      } else {
        logger.info('tower: LLM returned no goal summary', { identity });
      }
    } catch (err) {
      logger.info('tower: goal summary error', { identity, error: String(err) });
    }
  }

  private async refreshContextSummary(identity: string, jsonlPath: string): Promise<void> {
    try {
      const session = this.store.get(identity);
      const sessionId = session?.sessionId ?? identity;
      logger.info('tower: refreshing context summary', { identity, jsonlPath });
      const recentMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!recentMessages) {
        logger.info('tower: no recent messages found', { identity });
        this.store.update(identity, { summaryLoading: false });
        return;
      }
      // Skip if messages are too short to summarize meaningfully
      if (recentMessages.length < 20) {
        logger.info('tower: messages too short for LLM summary', { identity, len: recentMessages.length });
        return;
      }
      logger.info('tower: calling LLM for summary', { identity, msgLen: recentMessages.length });
      this.store.update(identity, { summaryLoading: true });
      const summary = await generateContextSummary(sessionId, recentMessages);
      if (summary) {
        logger.info('tower: context summary received', { identity, summary });
        this.store.updateMeta(identity, { contextSummary: summary });
        this.store.update(identity, { summaryLoading: false });
      } else {
        logger.info('tower: LLM returned no summary', { identity });
        this.store.update(identity, { summaryLoading: false });
      }
    } catch (err) {
      logger.info('tower: context summary error', { identity, error: String(err) });
    }
  }

  private async refreshNextSteps(identity: string, jsonlPath: string): Promise<void> {
    try {
      const session = this.store.get(identity);
      const sessionId = session?.sessionId ?? identity;
      const recentMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!recentMessages || recentMessages.length < 20) return;
      const suggestion = await generateNextSteps(sessionId, recentMessages);
      if (suggestion) {
        logger.info('tower: next steps received', { identity, suggestion });
        this.store.updateMeta(identity, { nextSteps: suggestion });
      }
    } catch (err) {
      logger.info('tower: next steps error', { identity, error: String(err) });
    }
  }

  private async refreshRemoteNextSteps(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    try {
      const tail = await remoteReadJsonlTail(config, jsonlPath, 65536);
      if (!tail || tail.length < 20) return;
      const lines = tail.split('\n').filter(l => l.trim());
      const meaningful: string[] = [];
      for (let i = lines.length - 1; i >= 0 && meaningful.length < 15; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          meaningful.unshift(lines[i]!);
        }
      }
      const recentText = meaningful.join('\n');
      if (recentText.length < 20) return;
      const suggestion = await generateNextSteps(compositeId, recentText);
      if (suggestion) {
        logger.info('tower: remote next steps received', { compositeId, suggestion });
        this.store.updateMeta(compositeId, { nextSteps: suggestion });
      }
    } catch (err) {
      logger.debug('tower: remote next steps error', { compositeId, error: String(err) });
    }
  }

  /** Run all three remote summary refreshes concurrently, managing summaryLoading as a unit. */
  private async refreshAllRemoteSummaries(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    this.store.update(compositeId, { summaryLoading: true });
    try {
      await Promise.all([
        this.refreshRemoteGoalSummary(compositeId, config, jsonlPath),
        this.refreshRemoteContextSummary(compositeId, config, jsonlPath),
        this.refreshRemoteNextSteps(compositeId, config, jsonlPath),
      ]);
    } finally {
      this.store.update(compositeId, { summaryLoading: false });
    }
  }

  private async refreshRemoteGoalSummary(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    try {
      const tail = await remoteReadJsonlTail(config, jsonlPath, 65536);
      if (!tail || tail.length < 20) return;
      const lines = tail.split('\n').filter(l => l.trim());
      const meaningful: string[] = [];
      for (let i = lines.length - 1; i >= 0 && meaningful.length < 15; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          meaningful.unshift(lines[i]!);
        }
      }
      const earlyText = meaningful.join('\n');
      if (earlyText.length < 20) return;
      const summary = await generateGoalSummary(compositeId, earlyText);
      if (summary) {
        logger.info('tower: remote goal summary received', { compositeId, summary });
        this.store.updateMeta(compositeId, { goalSummary: summary });
      }
    } catch (err) {
      logger.debug('tower: remote goal summary error', { compositeId, error: String(err) });
    }
  }

  private async refreshRemoteContextSummary(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    try {
      const tail = await remoteReadJsonlTail(config, jsonlPath, 65536);
      if (!tail || tail.length < 20) return;
      const lines = tail.split('\n').filter(l => l.trim());
      const meaningful: string[] = [];
      for (let i = lines.length - 1; i >= 0 && meaningful.length < 15; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          meaningful.unshift(lines[i]!);
        }
      }
      const recentText = meaningful.join('\n');
      if (recentText.length < 20) return;
      const summary = await generateContextSummary(compositeId, recentText);
      if (summary) {
        logger.info('tower: remote context summary received', { compositeId, summary });
        this.store.updateMeta(compositeId, { contextSummary: summary });
      }
    } catch (err) {
      logger.debug('tower: remote context summary error', { compositeId, error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.releaseLock();
    this.discovery.stop();
    this.jsonlWatcher.unwatchAll();
    this.processMonitor.stopAll();
    this.store.persistSync();
    // Fire-and-forget: don't await these to avoid slow shutdown
    this.hookReceiver.stop().catch(() => {});
    stopLlmSession().catch(() => {});
    // SSH cleanup
    if (this.remoteDiscovery) this.remoteDiscovery.stop();
    if (this.connectionManager) this.connectionManager.stopAll();
    for (const [, timer] of this.remotePollers) clearInterval(timer);
    this.remotePollers.clear();
  }

  private async registerSession(info: SessionInfo, opts: { skipJsonlFallback?: boolean } = {}): Promise<void> {
    // Skip /tmp sessions (LLM summarizer, ephemeral subprocesses, etc.)
    if (info.cwd.startsWith('/tmp')) return;

    // Skip headless sessions (claude --print) — non-interactive, should not appear in dashboard
    if (info.pid && isHeadlessProcess(info.pid)) {
      logger.debug('tower: skipping headless session', { pid: info.pid, cwd: info.cwd });
      return;
    }

    // a. Resolve tmux pane
    const mapping = await mapPidToPane(info.pid);

    // Cleanup any existing session occupying the same pane (new session started in same pane)
    if (mapping.paneId) {
      for (const existing of this.store.getAll()) {
        if (existing.paneId === mapping.paneId && existing.sessionId !== info.sessionId && existing.status !== 'dead') {
          logger.info('tower: evicting session — same pane taken by new session', { evicted: existing.sessionId, new: info.sessionId, paneId: mapping.paneId });
          this.cleanupSession(sessionIdentity(existing));
        }
      }
    }

    // b. Compute JSONL path (with fallback to latest file if sessionId doesn't match)
    const claudeDir = this.config.discovery.claude_dir.replace('~', os.homedir());
    const slug = cwdToSlug(info.cwd);
    const projectDir = path.join(claudeDir, 'projects', slug);
    let jsonlPath = path.join(projectDir, `${info.sessionId}.jsonl`);

    // Check for a newer JSONL only when the exact sessionId file does not exist.
    // After /clear, Claude Code immediately creates the new JSONL as an empty file,
    // so exactExists===true but size===0 → do NOT fallback (it's a fresh session).
    // After stale discovery (sessions/{pid}.json has old sessionId), the exact file
    // is missing entirely → use newest JSONL in the directory.
    // skipJsonlFallback: additional override for runtime /clear detection.
    try {
      const exactExists = fs.existsSync(jsonlPath);
      const exactSize = exactExists ? fs.statSync(jsonlPath).size : 0;
      if (!exactExists && !opts.skipJsonlFallback) {
        // Skip JSONLs already watched by another active session (prevents same-cwd sessions sharing a JSONL)
        const watchedJsonls = new Set(this.jsonlPaths.values());
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
          .map(f => ({ name: f, path: path.join(projectDir, f), mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        const candidate = files.find(f => f.path !== jsonlPath && !watchedJsonls.has(f.path));
        if (candidate) {
          logger.debug('tower: using fallback JSONL (exact missing — stale discovery)', {
            sessionId: info.sessionId,
            exact: path.basename(jsonlPath),
            fallback: candidate.name,
          });
          jsonlPath = candidate.path;
        }
      } else {
        logger.debug('tower: using exact JSONL', {
          sessionId: info.sessionId,
          file: path.basename(jsonlPath),
          exists: exactExists,
          size: exactSize,
        });
      }
    } catch {}

    // c. Cold start: determine current state + last task from JSONL
    const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);
    const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);
    const customTitle = this.jsonlWatcher.coldStartCustomTitle(jsonlPath);

    // d. Determine detection mode
    const detectionMode = 'jsonl' as const;

    // e. Register in store
    const projectName = path.basename(info.cwd);
    const session: Session = {
      pid: info.pid,
      sessionId: info.sessionId,
      paneId: mapping.paneId,
      hasTmux: mapping.hasTmux,
      detectionMode,
      cwd: info.cwd,
      projectName,
      status: initialState,
      lastActivity: new Date(),
      currentTask: lastTask,
      startedAt: new Date(info.startedAt),
      messageCount: 0,
      toolCallCount: 0,
      host: info.host ?? 'local',
      sshTarget: info.sshTarget,
    };
    this.store.register(session);

    // Apply custom title from JSONL (/rename) — always overwrite persisted label
    if (customTitle) {
      this.store.updateMeta(sessionIdentity(session), { label: customTitle });
    }

    // f. Rename tmux session to claude-{projectName} for local sessions with a pane
    if (mapping.paneId && !info.host) {
      void this.ensureTmuxSessionName(mapping.paneId, projectName);
    }

    // g. Create state machine
    const identity = sessionIdentity(session);
    const fsm = new SessionStateMachine(info.sessionId, initialState);
    fsm.on('state-change', (change) => {
      const currentSession = this.store.get(identity);
      const summary = this.summarizer.summarize(
        change.to,
        { type: change.to === 'idle' ? 'assistant' : 'user', stopReason: change.to === 'idle' ? 'end_turn' : undefined },
        [],
      );
      this.store.update(identity, {
        status: change.to,
        lastActivity: new Date(),
        currentSummary: {
          ...summary,
          summary: currentSession?.currentTask
            ? `${change.to === 'idle' ? '✓ ' : ''}${currentSession.currentTask}`
            : summary.summary,
        },
      });
      this.emit('state-change', change);
      this.notifier.onStateChange(change);

      // Trigger LLM summary refresh on idle transition
      if (change.to === 'idle') {
        const currentSess = this.store.get(identity);
        let jp = currentSess ? this.jsonlPaths.get(currentSess.sessionId) : undefined;
        // Re-check: use most recently modified JSONL (conversation ID may differ from session ID)
        if (jp && currentSess) {
          try {
            const dir = path.dirname(jp);
            const files = fs.readdirSync(dir)
              .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
              .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
              const newest = path.join(dir, files[0]!.name);
              if (newest !== jp) {
                jp = newest;
                this.jsonlPaths.set(currentSess.sessionId, jp);
                this.jsonlWatcher.unwatch(currentSess.sessionId);
                this.jsonlWatcher.watch(currentSess.sessionId, jp);
                logger.info('tower: JSONL path updated on idle', { identity, newPath: jp });
              }
            }
          } catch {}
        }
        if (jp) {
          void this.refreshGoalSummary(identity, jp);
          void this.refreshContextSummary(identity, jp);
          void this.refreshNextSteps(identity, jp);
        }
      }
    });

    // PID liveness check on inactivity timeout — only go idle if the process is actually dead
    fsm.on('inactivity-check', () => {
      const sess = this.store.get(identity);
      if (!sess || sess.status === 'idle' || sess.status === 'dead') return;
      if (isPidAlive(sess.pid)) {
        // Process still alive — reset the timer by re-entering current state via a no-op transition
        logger.debug('tower: inactivity-check — PID alive, resetting timer', { identity, pid: sess.pid });
        fsm.resetInactivityTimer();
      } else {
        logger.info('tower: inactivity-check — PID dead, transitioning to idle', { identity, pid: sess.pid });
        fsm.transition({ type: 'stop' });
      }
    });

    this.stateMachines.set(identity, fsm);

    // h. Track JSONL path + start watcher
    this.jsonlPaths.set(info.sessionId, jsonlPath);
    this.jsonlWatcher.watch(info.sessionId, jsonlPath);

    // i. If no tmux, also start process monitor as extra signal
    if (!mapping.hasTmux) {
      this.processMonitor.startPolling(info.pid, this.config.tracking.process_scan_interval);
    }

    logger.info('tower: session registered', {
      identity,
      sessionId: info.sessionId,
      pane: mapping.paneId ?? 'none',
      state: initialState,
      mode: detectionMode,
    });
  }

  private async registerRemoteSession(info: RemoteSessionInfo): Promise<void> {
    const compositeId = `${info.host}::${info.sessionId}`;

    // Skip if already registered
    if (this.store.get(compositeId)) return;

    // Find host config
    const hostConfig = this.config.hosts.find(h => h.name === info.host);
    if (!hostConfig) return;

    const remoteConfig: RemoteHostConfig = {
      sshTarget: hostConfig.ssh,
      sshOptions: hostConfig.ssh_options,
      claudeDir: hostConfig.claude_dir,
      commandPrefix: hostConfig.command_prefix,
    };

    // Compute remote JSONL path (with fallback to latest file)
    const claudeDir = hostConfig.claude_dir ?? '~/.claude';
    const slug = cwdToSlug(info.cwd);
    let jsonlPath = `${claudeDir}/projects/${slug}/${info.sessionId}.jsonl`;

    // Fallback: find the most recently modified JSONL in the remote project dir
    try {
      const lsOut = await sshExec(hostConfig.ssh, `ls -t ${claudeDir}/projects/${slug}/*.jsonl 2>/dev/null | head -1`, { sshOptions: hostConfig.ssh_options, commandPrefix: hostConfig.command_prefix, timeout: 5000 });
      const newest = lsOut.trim();
      if (newest && newest !== jsonlPath) {
        logger.debug('tower: remote using newest JSONL', { sessionId: info.sessionId, newest });
        jsonlPath = newest;
      }
    } catch {}

    // Cold start: read remote JSONL tail for initial state
    let initialState: 'idle' | 'thinking' | 'executing' = 'idle';
    let lastTask: string | undefined;
    try {
      const tail = await remoteReadJsonlTail(remoteConfig, jsonlPath);
      // Parse the tail to determine state (reuse existing parsing logic)
      const lines = tail.split('\n').filter(l => l.trim());
      // Walk backwards like coldStartScan
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (!parsed) continue;
        if (parsed.type === 'system' && (parsed.systemSubtype === 'turn_duration' || parsed.systemSubtype === 'stop_hook_summary')) {
          initialState = 'idle'; break;
        }
        if (parsed.type === 'assistant') {
          if (parsed.stopReason === 'end_turn') { initialState = 'idle'; break; }
          if (parsed.stopReason === 'tool_use') { initialState = 'executing'; break; }
          if (parsed.stopReason === null) { initialState = 'thinking'; break; }
        }
      }
      // Find last user task
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (parsed?.type === 'user' && parsed.userContent) {
          const text = parsed.userContent.trim();
          if (!isInternalMessage(text)) {
            lastTask = cleanDisplayText(text).slice(0, 80);
            break;
          }
        }
      }
    } catch {}

    // Find remote pane for this session's PID (single SSH call — walk ancestors)
    let paneId: string | undefined;
    try {
      const panes = await remoteListPanes(remoteConfig);
      const panePidSet = new Set(panes.map(p => p.pid));
      // Walk up the process tree from claude PID until we hit a pane PID
      const ancestryCmd = `P=${info.pid}; for i in 1 2 3 4 5; do P=$(ps -o ppid= -p $P 2>/dev/null | tr -d " "); [ -z "$P" ] || [ "$P" = "1" ] && break; echo $P; done`;
      const ancestryOut = await sshExec(hostConfig.ssh, ancestryCmd, { sshOptions: hostConfig.ssh_options, commandPrefix: hostConfig.command_prefix, timeout: 5000 });
      logger.info('tower: remote pane ancestry', { pid: info.pid, ancestry: ancestryOut.trim(), panePids: Array.from(panePidSet) });
      for (const line of ancestryOut.trim().split('\n')) {
        const ancestor = parseInt(line);
        if (ancestor && panePidSet.has(ancestor)) {
          paneId = panes.find(p => p.pid === ancestor)?.paneId;
          break;
        }
      }
    } catch {}

    const projectName = info.cwd.split('/').pop() ?? info.cwd;
    const session: Session = {
      pid: info.pid,
      sessionId: compositeId,
      paneId,
      hasTmux: true, // remote sessions are always in tmux; paneId may be undefined if detection failed
      detectionMode: hostConfig.hooks ? 'hook' : 'jsonl',
      cwd: info.cwd,
      projectName,
      status: initialState,
      lastActivity: new Date(),
      currentTask: lastTask,
      startedAt: new Date(info.startedAt),
      messageCount: 0,
      toolCallCount: 0,
      host: info.host,
      sshTarget: info.sshTarget,
      commandPrefix: hostConfig.command_prefix,
      hostOnline: true,
    };
    this.store.register(session);

    // Create state machine
    const fsm = new SessionStateMachine(compositeId, initialState);
    fsm.on('state-change', (change) => {
      this.store.update(compositeId, {
        status: change.to,
        lastActivity: new Date(),
      });
      this.emit('state-change', change);
      this.notifier.onStateChange(change);

      // Trigger LLM summary refresh on idle transition
      if (change.to === 'idle') {
        void this.refreshAllRemoteSummaries(compositeId, remoteConfig, jsonlPath);
      }
    });
    this.remoteStateMachines.set(compositeId, fsm);

    // Initial summary for idle sessions — skip if already summarized (Tower restart)
    if (initialState === 'idle') {
      const existing = this.store.get(compositeId);
      if (!existing?.goalSummary || !existing?.contextSummary) {
        void this.refreshAllRemoteSummaries(compositeId, remoteConfig, jsonlPath);
      }
    }

    // Store JSONL path for remote polling
    this.jsonlPaths.set(compositeId, jsonlPath);

    // Start remote JSONL polling for non-hook hosts
    if (!hostConfig.hooks) {
      this.startRemoteJsonlPoller(compositeId, remoteConfig, jsonlPath);
    }

    logger.info('tower: remote session registered', {
      compositeId, host: info.host, state: initialState, paneId: paneId ?? 'none',
    });
  }

  private startRemoteJsonlPoller(compositeId: string, config: RemoteHostConfig, jsonlPath: string): void {
    const timer = setInterval(async () => {
      if (this.stopping) return;
      const session = this.store.get(compositeId);
      if (!session) { clearInterval(timer); return; }

      try {
        const tail = await remoteReadJsonlTail(config, jsonlPath);
        const lines = tail.split('\n').filter(l => l.trim());
        const fsm = this.remoteStateMachines.get(compositeId);
        if (!fsm) return;

        // Find the most recent state-determining message
        for (let i = lines.length - 1; i >= 0; i--) {
          const parsed = parseJsonlLine(lines[i]!);
          if (!parsed) continue;

          // system turn_duration / stop_hook_summary / local_command → idle
          if (parsed.type === 'system' && (parsed.systemSubtype === 'turn_duration' || parsed.systemSubtype === 'stop_hook_summary' || parsed.systemSubtype === 'local_command')) {
            fsm.transition({ type: 'jsonl', stopReason: 'end_turn' } as InputEvent);
            break;
          }

          // user message → thinking (Claude is about to respond)
          if (parsed.type === 'user' && parsed.userContent) {
            const text = parsed.userContent.trim();
            if (!isInternalMessage(text)) {
              this.store.update(compositeId, { currentTask: cleanDisplayText(text).slice(0, 80) });
            }
            fsm.transition({ type: 'jsonl', stopReason: null } as InputEvent);  // thinking
            break;
          }

          // assistant message → determine state from stopReason
          if (parsed.type === 'assistant' && parsed.stopReason !== undefined) {
            fsm.transition({ type: 'jsonl', stopReason: parsed.stopReason } as InputEvent);
            break;
          }
        }
      } catch {}
    }, 3000);
    this.remotePollers.set(compositeId, timer);
  }

  /** Immediate cleanup — no dead state, no 30s delay. Used for session migration (clear/resume). */
  private cleanupSession(identity: string): void {
    const session = this.store.get(identity);
    if (!session) return;
    const sessionId = session.sessionId;
    const fsm = this.stateMachines.get(identity);
    if (fsm) { fsm.destroy(); fsm.removeAllListeners(); this.stateMachines.delete(identity); }
    this.jsonlPaths.delete(sessionId);
    this.jsonlWatcher.unwatch(sessionId);
    this.processMonitor.stopPolling(session.pid);
    const remoteTimer = this.remotePollers.get(sessionId);
    if (remoteTimer) { clearInterval(remoteTimer); this.remotePollers.delete(sessionId); }
    this.store.unregister(identity);
  }

  private deregisterSession(sessionId: string): void {
    // Accept sessionId (from discovery events) — resolve to identity via store
    const session = this.store.getBySessionId(sessionId);
    if (!session) return;
    const identity = sessionIdentity(session);

    // Clean up state machine (try local then remote)
    const fsm = this.stateMachines.get(identity) ?? this.remoteStateMachines.get(sessionId);
    if (fsm) {
      fsm.transition({ type: 'session-end' });
      fsm.destroy();
      fsm.removeAllListeners();
      this.stateMachines.delete(identity);
      this.remoteStateMachines.delete(sessionId);
    }

    // Clean up watchers
    this.jsonlWatcher.unwatch(sessionId);
    this.jsonlPaths.delete(sessionId);
    this.processMonitor.stopPolling(session.pid);

    // Clean up remote poller if any
    const remoteTimer = this.remotePollers.get(sessionId);
    if (remoteTimer) {
      clearInterval(remoteTimer);
      this.remotePollers.delete(sessionId);
    }

    // Mark as dead, auto-remove after 30 seconds
    this.store.update(identity, { status: 'dead', currentActivity: 'Session ended' });
    setTimeout(() => {
      this.store.unregister(identity);
    }, 30000);
  }

  private resolveIdentity(hookSid: string, hookCwd: string | undefined, hookPid?: number): string | null {
    // 1. Cached reverse mapping from previous resolution (O(1) fast path)
    const cached = this.hookSidToIdentity.get(hookSid);
    if (cached && this.stateMachines.has(cached)) return cached;

    // 2. Composite key match: remoteStateMachines stores "host::bareId", hook sends bare id.
    for (const key of this.remoteStateMachines.keys()) {
      if (key.endsWith(`::${hookSid}`)) {
        this.hookSidToIdentity.set(hookSid, key);
        logger.debug('tower: hook sid matched via composite key', { hookSid, compositeId: key });
        return key;
      }
    }

    // 3. PID-ancestry match: walk ppid chain from hookPid to find session whose pid is an ancestor
    if (hookPid && hookPid > 0) {
      let current = hookPid;
      let depth = 0;
      while (current > 1 && depth < 15) {
        for (const session of this.store.getAll()) {
          const id = sessionIdentity(session);
          if (session.pid && session.pid === current && session.status !== 'dead' && this.stateMachines.has(id)) {
            this.hookSidToIdentity.set(hookSid, id);
            logger.debug('tower: hook sid mapped to session via PID ancestry', { hookSid, identity: id, hookPid, matchedPid: current });
            return id;
          }
        }
        const ppid = getPpid(current);
        if (ppid === null || ppid === current || ppid <= 1) break;
        current = ppid;
        depth++;
      }
    }

    return null;
  }


  private handleHookEvent(event: any): void {
    const hookSid = event.sid;
    if (!hookSid || typeof hookSid !== 'string') return;

    // Skip hook events from sdk-cli (headless) sessions — e.g. services that spawn claude
    // programmatically inside the same project. Their events must not be attributed to the
    // parent interactive session via PID ancestry.
    if (event.pid && event.pid > 0) {
      try {
        const sessionsDir = this.config.discovery.claude_dir.replace('~', os.homedir()) + '/sessions';
        const raw = fs.readFileSync(path.join(sessionsDir, `${event.pid}.json`), 'utf8');
        const end = raw.indexOf('}');
        const parsed = JSON.parse(end >= 0 ? raw.slice(0, end + 1) : raw) as { entrypoint?: string };
        if (parsed.entrypoint === 'sdk-cli') {
          logger.debug('tower: ignoring hook event from sdk-cli session', { hookSid, pid: event.pid });
          return;
        }
      } catch {}
    }

    // When CLAUDE_SESSION_ID is not available (sid='unknown'), resolve by PID ancestry only
    let identity = this.resolveIdentity(hookSid, event.cwd, event.pid);
    if (!identity) {
      logger.info('tower: hook event for unknown session', { hookSid, event: event.event, cwd: event.cwd });
      // session-start from unknown session = likely /clear or new session — trigger immediate re-scan
      // Ignore /tmp sessions (LLM summarizer spawns claude --print there)
      if (event.event === 'session-start' && event.cwd && !event.cwd.startsWith('/tmp')) {
        // Check if the new session is headless (claude --print) by finding its PID
        // from ~/.claude/sessions/{pid}.json — skip if headless to avoid evicting interactive sessions
        try {
          const sessionsDir = this.config.discovery.claude_dir.replace('~', os.homedir()) + '/sessions';
          const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try {
              const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf8');
              const parsed = JSON.parse(raw) as { sessionId?: string; pid?: number; entrypoint?: string };
              if (parsed.sessionId === hookSid && parsed.pid) {
                if (isHeadlessProcess(parsed.pid) || parsed.entrypoint === 'sdk-cli') {
                  logger.debug('tower: ignoring session-start from headless/sdk-cli process', { hookSid, pid: parsed.pid, entrypoint: parsed.entrypoint, cwd: event.cwd });
                  return;
                }
                break;
              }
            } catch {}
          }
        } catch {}

        // Find the dead/dying session with same CWD for metadata migration.
        // Only match if the hook pid matches the session pid (same claude process = /clear).
        // A different pid means a new parallel session (e.g. sdk-cli) — not a /clear.
        const dyingSession = event.cwd
          ? this.store.getAll().find(s => s.cwd === event.cwd && (!event.pid || s.pid === event.pid))
          : undefined;
        const migratedMeta = dyingSession ? {
          label: dyingSession.label,
          tags: dyingSession.tags,
          favorite: dyingSession.favorite,
          favoritedAt: dyingSession.favoritedAt,
        } : undefined;

        // Clean up the old session immediately (/clear creates a new session)
        if (dyingSession) {
          this.cleanupSession(sessionIdentity(dyingSession));
        }

        logger.info('tower: new session via hook (likely /clear)', { hookSid, cwd: event.cwd, migrateFrom: dyingSession?.sessionId });

        // Register directly using hookSid — sessions/{pid}.json is stale after /clear
        if (event.cwd && hookSid !== 'unknown') {
          void (async () => {
            const info: SessionInfo = {
              pid: dyingSession?.pid ?? 0,
              sessionId: hookSid,
              cwd: event.cwd!,
              startedAt: Date.now(),
            };
            await this.registerSession(info, { skipJsonlFallback: true });
            // Use pane from hook payload if available (more reliable than PID→TTY chain)
            const newIdentity = event.pane ?? (hookSid !== 'unknown' ? hookSid : String(dyingSession?.pid ?? 0));
            if (event.pane) {
              this.store.update(newIdentity, { paneId: event.pane, hasTmux: true });
            }
            // Intentional: /clear preserves only favorite status — label/tags/summaries start fresh
            if (migratedMeta && migratedMeta.favorite) {
              this.store.updateMeta(newIdentity, { favorite: migratedMeta.favorite, favoritedAt: migratedMeta.favoritedAt });
              logger.info('tower: migrated favorite to new session', { from: dyingSession?.sessionId, to: hookSid });
            }
            // Map hookSid to new identity for future hook events
            this.hookSidToIdentity.set(hookSid, newIdentity);
          })();
        }
      }
      return;
    }
    // Ignore session-end from subagents: if hookSid doesn't directly match the session's sessionId,
    // it's likely a subagent ending (same CWD, different session ID).
    const resolvedSession = this.store.get(identity);
    if (event.event === 'session-end' && resolvedSession && hookSid !== resolvedSession.sessionId && !identity.endsWith(`::${hookSid}`)) {
      logger.info('tower: ignoring session-end from subagent', { hookSid, identity });
      return;
    }

    logger.info('tower: hook event received', { event: event.event, identity, hookSid });

    const session = this.store.get(identity);
    if (session) {
      const patch: Record<string, unknown> = {};
      // Upgrade to hook mode on first hook event
      if (session.detectionMode !== 'hook') patch['detectionMode'] = 'hook';
      // Use pane ID from hook payload directly — more reliable than PID→TTY chain
      if (event.pane && event.pane !== session.paneId) {
        // K. paneId upgrade path — rekey all maps if identity changes
        const oldIdentity = sessionIdentity(session);
        patch['paneId'] = event.pane;
        patch['hasTmux'] = true;
        logger.debug('tower: pane updated from hook', { identity, pane: event.pane });
        if (Object.keys(patch).length > 0) this.store.update(oldIdentity, patch);
        const newIdentity = sessionIdentity({ ...session, paneId: event.pane });
        if (oldIdentity !== newIdentity) {
          this.store.rekey(oldIdentity, newIdentity);
          const fsm2 = this.stateMachines.get(oldIdentity);
          if (fsm2) { this.stateMachines.delete(oldIdentity); this.stateMachines.set(newIdentity, fsm2); }
          for (const [hSid, id] of this.hookSidToIdentity) {
            if (id === oldIdentity) this.hookSidToIdentity.set(hSid, newIdentity);
          }
          identity = newIdentity; // update local var so FSM lookup below uses correct key
        }
      } else if (Object.keys(patch).length > 0) {
        this.store.update(identity, patch);
      }
    }

    const fsm = this.stateMachines.get(identity) ?? this.remoteStateMachines.get(identity);
    if (!fsm) return;

    // Map hook event to FSM input
    const inputEvent: InputEvent | null = this.mapHookToInput(event);
    if (inputEvent) {
      fsm.transition(inputEvent);
    }

    // On session-start for an already-idle session, force JSONL re-check + summary refresh.
    // This handles /resume: Claude Code does not update sessions/{pid}.json on /resume,
    // so the FSM stays idle→idle (no state-change emitted). Without this, the newer JSONL
    // created by /resume would never be detected and summaries would remain stale.
    if (event.event === 'session-start' && fsm.getState() === 'idle') {
      void this.refreshSessionAfterResume(identity);
    }

    // Update tool/message counts
    if (event.event === 'user-prompt') {
      const current = this.store.get(identity);
      if (current) {
        this.store.update(identity, { messageCount: current.messageCount + 1 });
      }
      // Refresh summaries on user input — captures new task context immediately
      const jp = current ? this.jsonlPaths.get(current.sessionId) : undefined;
      if (jp) {
        void this.refreshGoalSummary(identity, jp);
        void this.refreshContextSummary(identity, jp);
      }
    }
    if (event.event === 'pre-tool') {
      const current = this.store.get(identity);
      if (current) {
        this.store.update(identity, { toolCallCount: current.toolCallCount + 1 });
      }
    }
  }

  private handleJsonlEvent(sessionId: string, parsed: any): void {
    // sessionId here is the key used in jsonlPaths/jsonlWatcher — resolve to identity via store
    const session = this.store.getBySessionId(sessionId);
    if (!session) return;
    const identity = sessionIdentity(session);

    // Handle metadata events regardless of detection mode
    if (parsed.type === 'custom-title' && parsed.customTitle) {
      this.store.updateMeta(identity, { label: parsed.customTitle });
      this.store.persist();
      return;
    }

    // Skip JSONL-driven transitions if session is in hook mode
    if (session.detectionMode === 'hook') return;

    const fsm = this.stateMachines.get(identity);
    if (!fsm) return;

    // Map JSONL parsed message to FSM input + update live summary
    if (parsed.type === 'user') {
      const rawText = parsed.userContent?.trim() ?? '';
      if (!isInternalMessage(rawText)) {
        fsm.transition({ type: 'user-prompt' } as InputEvent);
        const cleaned = cleanDisplayText(rawText);
        this.store.update(identity, {
          messageCount: session.messageCount + 1,
          currentTask: cleaned.slice(0, 80),
          currentActivity: cleaned.slice(0, 60),
        });
        // LLM summaries are triggered on idle transition (state-change handler)
      }
    } else if (parsed.type === 'assistant') {
      if (parsed.stopReason === 'tool_use' && parsed.toolName) {
        fsm.transition({ type: 'jsonl', stopReason: 'tool_use' } as InputEvent);
        const toolDesc = parsed.toolInput
          ? `${parsed.toolName}: ${parsed.toolInput}`
          : parsed.toolName;
        this.store.update(identity, {
          toolCallCount: session.toolCallCount + 1,
          currentActivity: toolDesc,
        });
      } else if (parsed.stopReason === 'end_turn') {
        fsm.transition({ type: 'jsonl', stopReason: 'end_turn' } as InputEvent);
        const summary = parsed.assistantText
          ? `✓ ${cleanDisplayText(parsed.assistantText).split('.')[0]?.slice(0, 60) ?? 'Done'}`
          : '✓ Done';
        this.store.update(identity, { currentActivity: summary });
      } else if (parsed.stopReason === null) {
        fsm.transition({ type: 'jsonl', stopReason: null } as InputEvent);
      }
    } else if (parsed.type === 'progress' && parsed.progressType === 'agent_progress') {
      fsm.transition({ type: 'agent-start' } as InputEvent);
      this.store.update(identity, { currentTask: 'Subagent running...' });
    }
  }

  private mapHookToInput(event: any): InputEvent | null {
    switch (event.event) {
      case 'session-start': return { type: 'session-start' } as InputEvent;
      case 'user-prompt': return { type: 'user-prompt' } as InputEvent;
      case 'pre-tool': return { type: 'pre-tool' } as InputEvent;
      case 'post-tool': return { type: 'post-tool' } as InputEvent;
      case 'agent-start': return { type: 'agent-start' } as InputEvent;
      case 'agent-stop': return { type: 'agent-stop' } as InputEvent;
      case 'stop': return { type: 'stop' } as InputEvent;
      case 'session-end': return { type: 'session-end' } as InputEvent;
      default: return null;
    }
  }

  getStateMachine(sessionId: string): SessionStateMachine | undefined {
    // Try identity lookup first, fallback to sessionId (remote composite key)
    const session = this.store.getBySessionId(sessionId);
    if (session) {
      const id = sessionIdentity(session);
      return this.stateMachines.get(id) ?? this.remoteStateMachines.get(sessionId);
    }
    return this.stateMachines.get(sessionId) ?? this.remoteStateMachines.get(sessionId);
  }
}
