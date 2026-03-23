import { EventEmitter } from 'node:events';
import { Config } from '../config/defaults.js';
import { loadConfig } from '../config/loader.js';
import { DiscoveryEngine, SessionInfo } from './discovery.js';
import { SessionStore, Session } from './session-store.js';
import { HookReceiver } from './hook-receiver.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { ProcessMonitor } from './process-monitor.js';
import { SessionStateMachine, InputEvent } from './state-machine.js';
import { Summarizer } from './summarizer.js';
import { Notifier } from './notifier.js';
import { mapPidToPane } from '../tmux/pane-mapper.js';
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
  private hookSidToSessionId: Map<string, string> = new Map(); // CLAUDE_SESSION_ID → internal sessionId
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
      fs.writeFileSync(lockPath, `${process.pid}\n`);
      return true;
    } catch {
      // File exists — check if PID is still alive
      try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim());
        if (!isNaN(pid)) {
          try { process.kill(pid, 0); return false; } catch { /* stale lock */ }
        }
        // Stale lock — reclaim
        fs.unlinkSync(lockPath);
        this.lockFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockPath, `${process.pid}\n`);
        return true;
      } catch {
        return false;
      }
    }
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
      logger.info('tower: session changed (resume/clear)', { pid: next.pid, old: prev.sessionId, new: next.sessionId });
      // Migrate metadata from old session before deregistering
      const oldSession = this.store.get(prev.sessionId);
      // Migrate only identity metadata (not summaries — new session needs fresh context)
      const migratedMeta = oldSession ? {
        label: oldSession.label,
        tags: oldSession.tags,
        favorite: oldSession.favorite,
        favoritedAt: oldSession.favoritedAt,
      } : undefined;

      // Deregister old session immediately (no 30s dead delay for migrations)
      this.cleanupSession(prev.sessionId);

      // Register new session, then apply migrated metadata
      await this.registerSession(next);
      if (migratedMeta) {
        const patch: Record<string, unknown> = {};
        if (migratedMeta.label) patch['label'] = migratedMeta.label;
        if (migratedMeta.tags) patch['tags'] = migratedMeta.tags;
        if (migratedMeta.favorite) { patch['favorite'] = migratedMeta.favorite; patch['favoritedAt'] = migratedMeta.favoritedAt; }
        if (Object.keys(patch).length > 0) {
          this.store.update(next.sessionId, patch);
          logger.info('tower: session migrated (clear/resume)', { from: prev.sessionId, to: next.sessionId, keys: Object.keys(patch) });
        }
      }
    });

    // 8. Start periodic discovery
    this.discovery.start();

    // 9. Trigger initial summary for sessions that are already idle
    for (const session of this.store.getAll()) {
      if (session.status !== 'dead') {
        const jp = this.jsonlPaths.get(session.sessionId);
        if (jp) {
          void this.refreshGoalSummary(session.sessionId, jp);
          if (!session.contextSummary) void this.refreshContextSummary(session.sessionId, jp);
          if (!session.nextSteps && session.status === 'idle') void this.refreshNextSteps(session.sessionId, jp);
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
            this.store.update(session.sessionId, { hostOnline: false });
          }
        }
      });

      this.remoteDiscovery.on('host-online', (hostName: string) => {
        for (const session of this.store.getAll()) {
          if (session.host === hostName) {
            this.store.update(session.sessionId, { hostOnline: true });
          }
        }
      });

      this.remoteDiscovery.start(5000);
    }

    logger.info('tower: started successfully', { sessions: this.store.getAll().length });
  }


  /** Full refresh: re-scan discovery, re-register session, then regenerate LLM summaries. */
  async refreshSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;

    // Clear UI immediately
    clearSummaryCache(sessionId);
    this.store.update(sessionId, {
      goalSummary: undefined,
      contextSummary: undefined,
      nextSteps: undefined,
      summaryLoading: true,
    });

    // Re-scan discovery to pick up any changes (new PID, session file changes)
    const discovered = await this.discovery.scanOnce();
    const match = discovered.find(s => s.cwd === session.cwd) ?? discovered.find(s => s.sessionId === sessionId);

    if (match && match.sessionId !== sessionId) {
      // Session ID changed (e.g., /clear, /resume) — re-register
      logger.info('tower: refresh detected session change', { old: sessionId, new: match.sessionId });
      this.cleanupSession(sessionId);
      await this.registerSession(match);
      // Migrate metadata
      this.store.update(match.sessionId, {
        label: session.label,
        tags: session.tags,
        favorite: session.favorite,
        favoritedAt: session.favoritedAt,
        summaryLoading: true,
      });
      const jp = this.jsonlPaths.get(match.sessionId);
      if (jp) {
        void this.refreshGoalSummary(match.sessionId, jp);
        void this.refreshContextSummary(match.sessionId, jp);
        void this.refreshNextSteps(match.sessionId, jp);
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
          void this.refreshRemoteGoalSummary(sessionId, remoteConfig, jp);
          void this.refreshRemoteContextSummary(sessionId, remoteConfig, jp);
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
        void this.refreshGoalSummary(sessionId, updatedJp);
        void this.refreshContextSummary(sessionId, updatedJp);
        void this.refreshNextSteps(sessionId, updatedJp);
      } else {
        // No JSONL available — clear loading state
        this.store.update(sessionId, { summaryLoading: false });
        logger.info('tower: refresh skipped, no JSONL', { sessionId });
      }
    }
  }

  private async refreshGoalSummary(sessionId: string, jsonlPath: string): Promise<void> {
    try {
      logger.info('tower: refreshing goal summary', { sessionId, jsonlPath });
      const earlyMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!earlyMessages) {
        logger.info('tower: no early messages found for goal', { sessionId });
        return;
      }
      if (earlyMessages.length < 20) {
        logger.info('tower: early messages too short for goal summary', { sessionId, len: earlyMessages.length });
        return;
      }
      logger.info('tower: calling LLM for goal summary', { sessionId, msgLen: earlyMessages.length });
      const summary = await generateGoalSummary(sessionId, earlyMessages);
      if (summary) {
        logger.info('tower: goal summary received', { sessionId, summary });
        this.store.update(sessionId, { goalSummary: summary });
      } else {
        logger.info('tower: LLM returned no goal summary', { sessionId });
      }
    } catch (err) {
      logger.info('tower: goal summary error', { sessionId, error: String(err) });
    }
  }

  private async refreshContextSummary(sessionId: string, jsonlPath: string): Promise<void> {
    try {
      logger.info('tower: refreshing context summary', { sessionId, jsonlPath });
      const recentMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!recentMessages) {
        logger.info('tower: no recent messages found', { sessionId });
        return;
      }
      // Skip if messages are too short to summarize meaningfully
      if (recentMessages.length < 20) {
        logger.info('tower: messages too short for LLM summary', { sessionId, len: recentMessages.length });
        return;
      }
      logger.info('tower: calling LLM for summary', { sessionId, msgLen: recentMessages.length });
      this.store.update(sessionId, { summaryLoading: true });
      const summary = await generateContextSummary(sessionId, recentMessages);
      if (summary) {
        logger.info('tower: context summary received', { sessionId, summary });
        this.store.update(sessionId, { contextSummary: summary, summaryLoading: false });
      } else {
        logger.info('tower: LLM returned no summary', { sessionId });
        this.store.update(sessionId, { summaryLoading: false });
      }
    } catch (err) {
      logger.info('tower: context summary error', { sessionId, error: String(err) });
    }
  }

  private async refreshNextSteps(sessionId: string, jsonlPath: string): Promise<void> {
    try {
      const recentMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!recentMessages || recentMessages.length < 20) return;
      const suggestion = await generateNextSteps(sessionId, recentMessages);
      if (suggestion) {
        logger.info('tower: next steps received', { sessionId, suggestion });
        this.store.update(sessionId, { nextSteps: suggestion });
      }
    } catch (err) {
      logger.info('tower: next steps error', { sessionId, error: String(err) });
    }
  }

  private async refreshRemoteGoalSummary(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    try {
      this.store.update(compositeId, { summaryLoading: true });
      const session = this.store.get(compositeId);
      const tail = await remoteReadJsonlTail(config, jsonlPath, 65536);
      if (!tail || tail.length < 20) { this.store.update(compositeId, { summaryLoading: false }); return; }
      // Filter to user/assistant messages only (skip system/progress noise)
      const lines = tail.split('\n').filter(l => l.trim());
      const meaningful: string[] = [];
      for (let i = lines.length - 1; i >= 0 && meaningful.length < 15; i--) {
        const parsed = parseJsonlLine(lines[i]!);
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          meaningful.unshift(lines[i]!);
        }
      }
      const earlyText = meaningful.join('\n');
      if (earlyText.length < 20) { this.store.update(compositeId, { summaryLoading: false }); return; }
      const summary = await generateGoalSummary(compositeId, earlyText);
      if (summary) {
        logger.info('tower: remote goal summary received', { compositeId, summary });
        this.store.update(compositeId, { goalSummary: summary });
      }
    } catch (err) {
      logger.debug('tower: remote goal summary error', { compositeId, error: String(err) });
      this.store.update(compositeId, { summaryLoading: false });
    }
  }

  private async refreshRemoteContextSummary(compositeId: string, config: RemoteHostConfig, jsonlPath: string): Promise<void> {
    try {
      const tail = await remoteReadJsonlTail(config, jsonlPath, 65536);
      if (!tail || tail.length < 20) return;
      // Filter to user/assistant messages only (skip system/progress noise)
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
      this.store.update(compositeId, { summaryLoading: true });
      const summary = await generateContextSummary(compositeId, recentText);
      if (summary) {
        logger.info('tower: remote context summary received', { compositeId, summary });
        this.store.update(compositeId, { contextSummary: summary, summaryLoading: false });
      } else {
        this.store.update(compositeId, { summaryLoading: false });
      }
    } catch (err) {
      logger.debug('tower: remote context summary error', { compositeId, error: String(err) });
      this.store.update(compositeId, { summaryLoading: false });
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

  private async registerSession(info: SessionInfo): Promise<void> {
    // Skip the hidden LLM session
    if (info.cwd === '/tmp/cc-tower-llm') return;

    // a. Resolve tmux pane
    const mapping = await mapPidToPane(info.pid);

    // b. Compute JSONL path (with fallback to latest file if sessionId doesn't match)
    const claudeDir = this.config.discovery.claude_dir.replace('~', os.homedir());
    const slug = cwdToSlug(info.cwd);
    const projectDir = path.join(claudeDir, 'projects', slug);
    let jsonlPath = path.join(projectDir, `${info.sessionId}.jsonl`);

    // Always check for a newer JSONL in the project dir.
    // After /clear, Claude Code creates a new JSONL with a different sessionId
    // while keeping the same sessionId in sessions/*.json.
    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        const newest = path.join(projectDir, files[0]!.name);
        const exactMtime = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).mtimeMs : 0;
        if (files[0]!.mtime > exactMtime && newest !== jsonlPath) {
          logger.debug('tower: using newer JSONL over exact match', {
            sessionId: info.sessionId,
            exact: path.basename(jsonlPath),
            newest: files[0]!.name,
          });
          jsonlPath = newest;
        }
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
      this.store.update(info.sessionId, { label: customTitle });
    }

    // f. Create state machine
    const fsm = new SessionStateMachine(info.sessionId, initialState);
    fsm.on('state-change', (change) => {
      const currentSession = this.store.get(info.sessionId);
      const summary = this.summarizer.summarize(
        change.to,
        { type: change.to === 'idle' ? 'assistant' : 'user', stopReason: change.to === 'idle' ? 'end_turn' : undefined },
        [],
      );
      this.store.update(info.sessionId, {
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
        let jp = this.jsonlPaths.get(info.sessionId);
        // Re-check: use most recently modified JSONL (conversation ID may differ from session ID)
        if (jp) {
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
                this.jsonlPaths.set(info.sessionId, jp);
                this.jsonlWatcher.unwatch(info.sessionId);
                this.jsonlWatcher.watch(info.sessionId, jp);
                logger.info('tower: JSONL path updated on idle', { sessionId: info.sessionId, newPath: jp });
              }
            }
          } catch {}
        }
        if (jp) {
          void this.refreshGoalSummary(info.sessionId, jp);
          void this.refreshContextSummary(info.sessionId, jp);
          void this.refreshNextSteps(info.sessionId, jp);
        }
      }
    });
    this.stateMachines.set(info.sessionId, fsm);

    // g. Track JSONL path + start watcher
    this.jsonlPaths.set(info.sessionId, jsonlPath);
    this.jsonlWatcher.watch(info.sessionId, jsonlPath);

    // h. If no tmux, also start process monitor as extra signal
    if (!mapping.hasTmux) {
      this.processMonitor.startPolling(info.pid, this.config.tracking.process_scan_interval);
    }

    logger.info('tower: session registered', {
      sessionId: info.sessionId,
      pane: mapping.paneId ?? 'none',
      state: initialState,
      mode: detectionMode,
    });
  }

  private async registerRemoteSession(info: RemoteSessionInfo): Promise<void> {
    const compositeId = `${info.host}::${info.sessionId}`;

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
      hasTmux: !!paneId,
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
        void this.refreshRemoteGoalSummary(compositeId, remoteConfig, jsonlPath);
        void this.refreshRemoteContextSummary(compositeId, remoteConfig, jsonlPath);
      }
    });
    this.stateMachines.set(compositeId, fsm);

    // Initial summary for idle sessions
    if (initialState === 'idle') {
      void this.refreshRemoteGoalSummary(compositeId, remoteConfig, jsonlPath);
      void this.refreshRemoteContextSummary(compositeId, remoteConfig, jsonlPath);
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
        const fsm = this.stateMachines.get(compositeId);
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
  private cleanupSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    const fsm = this.stateMachines.get(sessionId);
    if (fsm) { fsm.destroy(); fsm.removeAllListeners(); this.stateMachines.delete(sessionId); }
    this.jsonlWatcher.unwatch(sessionId);
    this.jsonlPaths.delete(sessionId);
    this.processMonitor.stopPolling(session.pid);
    const remoteTimer = this.remotePollers.get(sessionId);
    if (remoteTimer) { clearInterval(remoteTimer); this.remotePollers.delete(sessionId); }
    this.hookSidToSessionId.delete(sessionId);
    this.store.unregister(sessionId);
  }

  private deregisterSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    // Clean up state machine
    const fsm = this.stateMachines.get(sessionId);
    if (fsm) {
      fsm.transition({ type: 'session-end' });
      fsm.destroy();
      fsm.removeAllListeners();
      this.stateMachines.delete(sessionId);
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
    this.store.update(sessionId, { status: 'dead', currentActivity: 'Session ended' });
    setTimeout(() => {
      this.store.unregister(sessionId);
    }, 30000);
  }

  private resolveSessionId(hookSid: string, hookCwd: string | undefined): string | null {
    // 1. Direct match (hook sid === internal sessionId)
    if (this.stateMachines.has(hookSid)) return hookSid;

    // 2. Cached reverse mapping from previous resolution (O(1) fast path)
    const cached = this.hookSidToSessionId.get(hookSid);
    if (cached && this.stateMachines.has(cached)) return cached;

    // 3. Composite key match: stateMachines stores "host::bareId", hook sends bare id.
    //    With multiple matches, first-match-wins is intentional (most recently added key wins).
    for (const key of this.stateMachines.keys()) {
      if (key.endsWith(`::${hookSid}`)) {
        this.hookSidToSessionId.set(hookSid, key);
        logger.debug('tower: hook sid matched via composite key', { hookSid, compositeId: key });
        return key;
      }
    }

    // 4. Fallback: match by CWD across all sessions
    if (hookCwd) {
      for (const session of this.store.getAll()) {
        if (session.cwd === hookCwd && session.status !== 'dead' && this.stateMachines.has(session.sessionId)) {
          this.hookSidToSessionId.set(hookSid, session.sessionId);
          logger.debug('tower: hook sid mapped to session via CWD', { hookSid, sessionId: session.sessionId, cwd: hookCwd });
          return session.sessionId;
        }
      }
    }

    return null;
  }

  private resolveSessionIdByCwd(hookCwd: string | undefined): string | null {
    if (!hookCwd) return null;
    for (const session of this.store.getAll()) {
      if (session.cwd === hookCwd && session.status !== 'dead' && this.stateMachines.has(session.sessionId)) {
        logger.debug('tower: hook resolved by CWD (no session ID)', { sessionId: session.sessionId, cwd: hookCwd });
        return session.sessionId;
      }
    }
    return null;
  }

  private handleHookEvent(event: any): void {
    const hookSid = event.sid;
    if (!hookSid || typeof hookSid !== 'string') return;

    // When CLAUDE_SESSION_ID is not available (sid='unknown'), resolve by CWD only
    const sessionId = hookSid === 'unknown'
      ? this.resolveSessionIdByCwd(event.cwd)
      : this.resolveSessionId(hookSid, event.cwd);
    if (!sessionId) {
      logger.info('tower: hook event for unknown session', { hookSid, event: event.event, cwd: event.cwd });
      // session-start from unknown session = likely /clear or new session — trigger immediate re-scan
      // Ignore /tmp sessions (LLM summarizer spawns claude --print there)
      if (event.event === 'session-start' && event.cwd && !event.cwd.startsWith('/tmp')) {
        // Find the dead/dying session with same CWD for metadata migration
        const dyingSession = event.cwd
          ? this.store.getAll().find(s => s.cwd === event.cwd && (s.status === 'dead' || s.status === 'idle'))
          : undefined;
        const migratedMeta = dyingSession ? {
          label: dyingSession.label,
          tags: dyingSession.tags,
          favorite: dyingSession.favorite,
          favoritedAt: dyingSession.favoritedAt,
        } : undefined;

        // Clean up the old session immediately (/clear creates a new session)
        if (dyingSession) {
          this.cleanupSession(dyingSession.sessionId);
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
            await this.registerSession(info);
            // Migrate metadata (label, favorite) but NOT summaries
            if (migratedMeta) {
              const patch: Record<string, unknown> = {};
              if (migratedMeta.label) patch['label'] = migratedMeta.label;
              if (migratedMeta.tags) patch['tags'] = migratedMeta.tags;
              if (migratedMeta.favorite) { patch['favorite'] = migratedMeta.favorite; patch['favoritedAt'] = migratedMeta.favoritedAt; }
              if (Object.keys(patch).length > 0) {
                this.store.update(hookSid, patch);
                logger.info('tower: migrated metadata to new session', { from: dyingSession?.sessionId, to: hookSid, keys: Object.keys(patch) });
              }
            }
            // Map hookSid to new sessionId for future hook events
            this.hookSidToSessionId.set(hookSid, hookSid);
          })();
        }
      }
      return;
    }
    // Ignore session-end from subagents: if hookSid doesn't directly match the session,
    // it's likely a subagent ending (same CWD, different session ID).
    if (event.event === 'session-end' && hookSid !== sessionId && !sessionId.endsWith(`::${hookSid}`)) {
      logger.info('tower: ignoring session-end from subagent', { hookSid, sessionId });
      return;
    }

    logger.info('tower: hook event received', { event: event.event, sessionId, hookSid });

    const session = this.store.get(sessionId);
    if (session && session.detectionMode !== 'hook') {
      // Upgrade to hook mode on first hook event
      this.store.update(sessionId, { detectionMode: 'hook' });
    }

    const fsm = this.stateMachines.get(sessionId);
    if (!fsm) return;

    // Map hook event to FSM input
    const inputEvent: InputEvent | null = this.mapHookToInput(event);
    if (inputEvent) {
      fsm.transition(inputEvent);
    }

    // Update tool/message counts
    if (event.event === 'user-prompt') {
      const current = this.store.get(sessionId);
      if (current) {
        this.store.update(sessionId, { messageCount: current.messageCount + 1 });
      }
      // Refresh summaries on user input — captures new task context immediately
      const jp = this.jsonlPaths.get(sessionId);
      if (jp) {
        void this.refreshGoalSummary(sessionId, jp);
        void this.refreshContextSummary(sessionId, jp);
      }
    }
    if (event.event === 'pre-tool') {
      const current = this.store.get(sessionId);
      if (current) {
        this.store.update(sessionId, { toolCallCount: current.toolCallCount + 1 });
      }
    }
  }

  private handleJsonlEvent(sessionId: string, parsed: any): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    // Handle metadata events regardless of detection mode
    if (parsed.type === 'custom-title' && parsed.customTitle) {
      this.store.update(sessionId, { label: parsed.customTitle });
      this.store.persist();
      return;
    }

    // Skip JSONL-driven transitions if session is in hook mode
    if (session.detectionMode === 'hook') return;

    const fsm = this.stateMachines.get(sessionId);
    if (!fsm) return;

    // Map JSONL parsed message to FSM input + update live summary
    if (parsed.type === 'user') {
      const rawText = parsed.userContent?.trim() ?? '';
      if (!isInternalMessage(rawText)) {
        fsm.transition({ type: 'user-prompt' } as InputEvent);
        const cleaned = cleanDisplayText(rawText);
        this.store.update(sessionId, {
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
        this.store.update(sessionId, {
          toolCallCount: session.toolCallCount + 1,
          currentActivity: toolDesc,
        });
      } else if (parsed.stopReason === 'end_turn') {
        fsm.transition({ type: 'jsonl', stopReason: 'end_turn' } as InputEvent);
        const summary = parsed.assistantText
          ? `✓ ${cleanDisplayText(parsed.assistantText).split('.')[0]?.slice(0, 60) ?? 'Done'}`
          : '✓ Done';
        this.store.update(sessionId, { currentActivity: summary });
      } else if (parsed.stopReason === null) {
        fsm.transition({ type: 'jsonl', stopReason: null } as InputEvent);
      }
    } else if (parsed.type === 'progress' && parsed.progressType === 'agent_progress') {
      fsm.transition({ type: 'agent-start' } as InputEvent);
      this.store.update(sessionId, { currentTask: 'Subagent running...' });
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
    return this.stateMachines.get(sessionId);
  }
}
