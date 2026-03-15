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
import { cwdToSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';
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

  constructor(config?: Config) {
    super();
    this.config = config ?? loadConfig();

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

    // 2. Start hook receiver (socket bind)
    try {
      await this.hookReceiver.start();
      logger.info('tower: hook receiver started');
    } catch (err) {
      logger.warn('tower: hook receiver failed to start, continuing without hooks', { error: String(err) });
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

    // 8. Start periodic discovery
    this.discovery.start();

    logger.info('tower: started successfully', { sessions: this.store.getAll().length });
  }

  async stop(): Promise<void> {
    logger.info('tower: stopping');
    this.discovery.stop();
    await this.hookReceiver.stop();
    this.jsonlWatcher.unwatchAll();
    this.processMonitor.stopAll();
    this.store.persist();
    logger.info('tower: stopped');
  }

  private async registerSession(info: SessionInfo): Promise<void> {
    // a. Resolve tmux pane
    const mapping = await mapPidToPane(info.pid);

    // b. Compute JSONL path
    const claudeDir = this.config.discovery.claude_dir.replace('~', os.homedir());
    const slug = cwdToSlug(info.cwd);
    const jsonlPath = path.join(claudeDir, 'projects', slug, `${info.sessionId}.jsonl`);

    // c. Cold start: determine current state from JSONL
    const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);

    // d. Determine detection mode
    // For now: assume hook if hook receiver is listening, but will be confirmed
    // when first hook event arrives. Default to jsonl.
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
      startedAt: new Date(info.startedAt),
      messageCount: 0,
      toolCallCount: 0,
    };
    this.store.register(session);

    // f. Create state machine
    const fsm = new SessionStateMachine(info.sessionId, initialState);
    fsm.on('state-change', (change) => {
      this.store.update(info.sessionId, {
        status: change.to,
        lastActivity: new Date(),
      });
      this.emit('state-change', change);
      this.notifier.onStateChange(change);
    });
    this.stateMachines.set(info.sessionId, fsm);

    // g. Start JSONL watcher (for all sessions — hooks supplement, JSONL is baseline)
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
    this.processMonitor.stopPolling(session.pid);

    // Update store
    this.store.update(sessionId, { status: 'dead' });
  }

  private handleHookEvent(event: any): void {
    const sessionId = event.sid;
    if (!sessionId) return;

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

    // Map JSONL parsed message to FSM input
    if (parsed.type === 'user') {
      fsm.transition({ type: 'user-prompt' } as InputEvent);
      this.store.update(sessionId, {
        messageCount: session.messageCount + 1,
        currentTask: parsed.userContent?.slice(0, 80),
      });
    } else if (parsed.type === 'assistant' && parsed.stopReason !== undefined) {
      fsm.transition({ type: 'jsonl', stopReason: parsed.stopReason } as InputEvent);
      if (parsed.stopReason === 'tool_use') {
        this.store.update(sessionId, { toolCallCount: session.toolCallCount + 1 });
      }
    } else if (parsed.type === 'progress' && parsed.progressType === 'agent_progress') {
      fsm.transition({ type: 'agent-start' } as InputEvent);
    }

    // Generate turn summary on state change
    // (summarizer integration happens via state-change event)
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
