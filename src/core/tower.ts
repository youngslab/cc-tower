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
import { generateContextSummary, startLlmSession, stopLlmSession, getLlmSessionName } from './llm-summarizer.js';
import { logger } from '../utils/logger.js';
import { parseJsonlLine } from '../utils/jsonl-parser.js';
import { ConnectionManager } from '../ssh/connection-manager.js';
import { RemoteDiscovery, RemoteSessionInfo } from '../ssh/remote-discovery.js';
import { remoteReadJsonlTail, RemoteHostConfig } from '../ssh/remote-commands.js';
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
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private connectionManager!: ConnectionManager;
  private remoteDiscovery: RemoteDiscovery | null = null;
  private remotePollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  private skipHooks: boolean;

  constructor(config?: Config, opts?: { skipHooks?: boolean }) {
    super();
    this.config = config ?? loadConfig();
    this.skipHooks = opts?.skipHooks ?? false;

    const persistPath = path.join(os.homedir(), '.local', 'share', 'cc-tower', 'state.json');
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

  async start(): Promise<void> {
    logger.info('tower: starting cc-tower');

    // === Cold Start Sequence ===
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

    // 4. For each session: resolve pane, cold start JSONL, register
    for (const info of sessions) {
      await this.registerSession(info);
    }

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
      // Deregister old session, re-register with new sessionId/JSONL
      this.deregisterSession(prev.sessionId);
      await this.registerSession(next);
    });

    // 8. Start periodic discovery
    this.discovery.start();

    // 9. Immediately trigger first summary update, then schedule next after completion
    void this.scheduleSummaryUpdate();

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
        config: { sshTarget: h.ssh, sshOptions: h.ssh_options, claudeDir: h.claude_dir } as RemoteHostConfig,
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

  private summaryRunning = false;

  private async scheduleSummaryUpdate(): Promise<void> {
    if (this.stopping) return;
    await this.updateSummaries();
    if (this.stopping) return;
    // Schedule next update: 5s for activity refresh, longer if all summaries are done
    const hasMissing = this.store.getAll().some(s => s.status !== 'dead' && !s.contextSummary);
    const delay = hasMissing ? 5000 : 30000;
    this.summaryTimer = setTimeout(() => {
      void this.scheduleSummaryUpdate();
    }, delay);
  }

  private async updateSummaries(): Promise<void> {
    // Update currentActivity for all sessions (instant, Tier 1+2)
    for (const session of this.store.getAll()) {
      if (session.status === 'dead') continue;
      const jsonlPath = this.jsonlPaths.get(session.sessionId);
      if (!jsonlPath) continue;
      try {
        const activity = await this.jsonlWatcher.readLatestActivity(jsonlPath);
        if (activity && activity !== session.currentActivity) {
          this.store.update(session.sessionId, { currentActivity: activity });
        }
      } catch {}
    }

    // LLM context summaries: parallel (tested: 4 parallel calls complete in ~8s)
    if (this.summaryRunning || this.stopping) return;
    this.summaryRunning = true;
    try {
      const pending = this.store.getAll()
        .filter(s => s.status !== 'dead' && !s.contextSummary)
        .map(s => ({ sessionId: s.sessionId, jsonlPath: this.jsonlPaths.get(s.sessionId) }))
        .filter((s): s is { sessionId: string; jsonlPath: string } => !!s.jsonlPath);

      if (pending.length > 0) {
        await Promise.all(
          pending.map(s => this.refreshContextSummary(s.sessionId, s.jsonlPath))
        );
      }
    } finally {
      this.summaryRunning = false;
    }
  }

  private async refreshContextSummary(sessionId: string, jsonlPath: string): Promise<void> {
    try {
      logger.debug('tower: refreshing context summary', { sessionId });
      const recentMessages = await this.jsonlWatcher.readRecentContext(jsonlPath, 15);
      if (!recentMessages) {
        logger.debug('tower: no recent messages found', { sessionId });
        return;
      }
      // Skip if messages are too short to summarize meaningfully
      if (recentMessages.length < 20) {
        logger.debug('tower: messages too short for LLM summary', { sessionId, len: recentMessages.length });
        return;
      }
      logger.debug('tower: calling LLM for summary', { sessionId, msgLen: recentMessages.length });
      this.store.update(sessionId, { summaryLoading: true });
      const summary = await generateContextSummary(sessionId, recentMessages);
      if (summary) {
        logger.debug('tower: context summary received', { sessionId, summary });
        this.store.update(sessionId, { contextSummary: summary, summaryLoading: false });
      } else {
        logger.debug('tower: LLM returned no summary', { sessionId });
        this.store.update(sessionId, { summaryLoading: false });
      }
    } catch (err) {
      logger.debug('tower: context summary error', { sessionId, error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.summaryTimer) {
      clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
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

    // Fallback: if exact JSONL doesn't exist, use most recently modified one
    // (handles --continue/--resume where sessionId differs from JSONL filename)
    if (!fs.existsSync(jsonlPath)) {
      try {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          jsonlPath = path.join(projectDir, files[0]!.name);
          logger.debug('tower: using fallback JSONL', { sessionId: info.sessionId, fallback: files[0]!.name });
        }
      } catch {}
    }

    // c. Cold start: determine current state + last task from JSONL
    const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);
    const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);

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
    };

    // Compute remote JSONL path
    const claudeDir = hostConfig.claude_dir ?? '~/.claude';
    const slug = cwdToSlug(info.cwd);
    const jsonlPath = `${claudeDir}/projects/${slug}/${info.sessionId}.jsonl`;

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

    const projectName = info.cwd.split('/').pop() ?? info.cwd;
    const session: Session = {
      pid: info.pid,
      sessionId: compositeId,
      hasTmux: true, // assume tmux on remote
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
    });
    this.stateMachines.set(compositeId, fsm);

    // Store JSONL path for remote polling
    this.jsonlPaths.set(compositeId, jsonlPath);

    // Start remote JSONL polling for non-hook hosts
    if (!hostConfig.hooks) {
      this.startRemoteJsonlPoller(compositeId, remoteConfig, jsonlPath);
    }

    logger.info('tower: remote session registered', {
      compositeId, host: info.host, state: initialState,
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
        // Find the most recent state-determining message
        for (let i = lines.length - 1; i >= 0; i--) {
          const parsed = parseJsonlLine(lines[i]!);
          if (!parsed) continue;
          const fsm = this.stateMachines.get(compositeId);
          if (!fsm) break;

          if (parsed.type === 'user' && parsed.userContent) {
            const text = parsed.userContent.trim();
            if (!isInternalMessage(text)) {
              this.store.update(compositeId, { currentTask: cleanDisplayText(text).slice(0, 80) });
            }
            break;
          }
          if (parsed.type === 'assistant' && parsed.stopReason !== undefined) {
            fsm.transition({ type: 'jsonl', stopReason: parsed.stopReason } as InputEvent);
            break;
          }
        }
      } catch {}
    }, 3000);
    this.remotePollers.set(compositeId, timer);
  }

  private deregisterSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    // Clean up state machine
    const fsm = this.stateMachines.get(sessionId);
    if (fsm) {
      fsm.transition({ type: 'session-end' });
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

    // 2. Cached reverse mapping from previous resolution
    const cached = this.hookSidToSessionId.get(hookSid);
    if (cached && this.stateMachines.has(cached)) return cached;

    // 3. Fallback: match by CWD across all sessions
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
    if (!hookSid) return;

    // When CLAUDE_SESSION_ID is not available (sid='unknown'), resolve by CWD only
    const sessionId = hookSid === 'unknown'
      ? this.resolveSessionIdByCwd(event.cwd)
      : this.resolveSessionId(hookSid, event.cwd);
    if (!sessionId) {
      logger.info('tower: hook event for unknown session', { hookSid, event: event.event, cwd: event.cwd });
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
        // Trigger async LLM context summary (non-blocking)
        const jsonlPath = this.jsonlPaths.get(sessionId);
        if (jsonlPath) {
          void this.refreshContextSummary(sessionId, jsonlPath);
        }
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
