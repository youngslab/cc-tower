import { EventEmitter } from 'node:events';
import { loadConfig } from '../config/loader.js';
import { DiscoveryEngine } from './discovery.js';
import { SessionStore } from './session-store.js';
import { HookReceiver } from './hook-receiver.js';
import { JsonlWatcher } from './jsonl-watcher.js';
import { ProcessMonitor } from './process-monitor.js';
import { SessionStateMachine } from './state-machine.js';
import { Summarizer } from './summarizer.js';
import { Notifier } from './notifier.js';
import { mapPidToPane } from '../tmux/pane-mapper.js';
import { cwdToSlug, cleanDisplayText, isInternalMessage } from '../utils/slug.js';
import { generateContextSummary, generateGoalSummary, startLlmSession, stopLlmSession } from './llm-summarizer.js';
import { logger } from '../utils/logger.js';
import { parseJsonlLine } from '../utils/jsonl-parser.js';
import { ConnectionManager } from '../ssh/connection-manager.js';
import { RemoteDiscovery } from '../ssh/remote-discovery.js';
import { remoteReadJsonlTail } from '../ssh/remote-commands.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export class Tower extends EventEmitter {
    config;
    store;
    discovery;
    hookReceiver;
    jsonlWatcher;
    processMonitor;
    summarizer;
    notifier;
    stateMachines = new Map();
    hookSidToSessionId = new Map(); // CLAUDE_SESSION_ID → internal sessionId
    jsonlPaths = new Map(); // sessionId → jsonlPath
    stopping = false;
    connectionManager;
    remoteDiscovery = null;
    remotePollers = new Map();
    skipHooks;
    constructor(config, opts) {
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
    async start() {
        logger.info('tower: starting cc-tower');
        // === Cold Start Sequence ===
        // 0. Clean up stale peek sessions from previous runs
        try {
            const { execSync } = await import('node:child_process');
            const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
            for (const name of sessions.split('\n')) {
                if (name.startsWith('_cctower_peek_')) {
                    try {
                        execSync(`tmux kill-session -t ${name} 2>/dev/null`);
                    }
                    catch { }
                }
            }
        }
        catch { }
        // 1. Restore user metadata (labels, tags) from disk
        this.store.restore();
        // 2. Start hook receiver (socket bind) — skip for one-shot commands to avoid stealing the TUI's socket
        if (!this.skipHooks) {
            try {
                await this.hookReceiver.start();
                logger.info('tower: hook receiver started');
            }
            catch (err) {
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
        this.discovery.on('session-found', async (info) => {
            logger.info('tower: new session found', { pid: info.pid, sessionId: info.sessionId });
            await this.registerSession(info);
        });
        this.discovery.on('session-lost', (info) => {
            logger.info('tower: session lost', { pid: info.pid, sessionId: info.sessionId });
            this.deregisterSession(info.sessionId);
        });
        this.discovery.on('session-changed', async ({ prev, next }) => {
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
                const patch = {};
                if (migratedMeta.label)
                    patch['label'] = migratedMeta.label;
                if (migratedMeta.tags)
                    patch['tags'] = migratedMeta.tags;
                if (migratedMeta.favorite) {
                    patch['favorite'] = migratedMeta.favorite;
                    patch['favoritedAt'] = migratedMeta.favoritedAt;
                }
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
                    if (!session.goalSummary)
                        void this.refreshGoalSummary(session.sessionId, jp);
                    if (!session.contextSummary)
                        void this.refreshContextSummary(session.sessionId, jp);
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
                    const success = await this.connectionManager.startTunnel(host.name, host.ssh, socketPath, host.ssh_options);
                    if (!success) {
                        logger.warn('tower: SSH tunnel failed, falling back to JSONL polling', { host: host.name });
                    }
                }
            }
            this.connectionManager.startHealthCheck(socketPath);
            // Start remote discovery
            const remoteHosts = this.config.hosts.map(h => ({
                name: h.name,
                config: { sshTarget: h.ssh, sshOptions: h.ssh_options, claudeDir: h.claude_dir },
            }));
            this.remoteDiscovery = new RemoteDiscovery(remoteHosts);
            this.remoteDiscovery.on('session-found', async (info) => {
                logger.info('tower: remote session found', { host: info.host, sessionId: info.sessionId });
                await this.registerRemoteSession(info);
            });
            this.remoteDiscovery.on('session-lost', (info) => {
                const key = `${info.host}::${info.sessionId}`;
                logger.info('tower: remote session lost', { host: info.host, sessionId: info.sessionId });
                this.deregisterSession(key);
            });
            this.remoteDiscovery.on('host-offline', (hostName) => {
                // Mark all sessions from this host as offline
                for (const session of this.store.getAll()) {
                    if (session.host === hostName) {
                        this.store.update(session.sessionId, { hostOnline: false });
                    }
                }
            });
            this.remoteDiscovery.on('host-online', (hostName) => {
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
    async refreshGoalSummary(sessionId, jsonlPath) {
        try {
            logger.info('tower: refreshing goal summary', { sessionId, jsonlPath });
            const earlyMessages = await this.jsonlWatcher.readEarlyContext(jsonlPath, 15);
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
            }
            else {
                logger.info('tower: LLM returned no goal summary', { sessionId });
            }
        }
        catch (err) {
            logger.info('tower: goal summary error', { sessionId, error: String(err) });
        }
    }
    async refreshContextSummary(sessionId, jsonlPath) {
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
            }
            else {
                logger.info('tower: LLM returned no summary', { sessionId });
                this.store.update(sessionId, { summaryLoading: false });
            }
        }
        catch (err) {
            logger.info('tower: context summary error', { sessionId, error: String(err) });
        }
    }
    async stop() {
        this.stopping = true;
        this.discovery.stop();
        this.jsonlWatcher.unwatchAll();
        this.processMonitor.stopAll();
        this.store.persistSync();
        // Fire-and-forget: don't await these to avoid slow shutdown
        this.hookReceiver.stop().catch(() => { });
        stopLlmSession().catch(() => { });
        // SSH cleanup
        if (this.remoteDiscovery)
            this.remoteDiscovery.stop();
        if (this.connectionManager)
            this.connectionManager.stopAll();
        for (const [, timer] of this.remotePollers)
            clearInterval(timer);
        this.remotePollers.clear();
    }
    async registerSession(info) {
        // Skip the hidden LLM session
        if (info.cwd === '/tmp/cc-tower-llm')
            return;
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
                    jsonlPath = path.join(projectDir, files[0].name);
                    logger.debug('tower: using fallback JSONL', { sessionId: info.sessionId, fallback: files[0].name });
                }
            }
            catch { }
        }
        // c. Cold start: determine current state + last task from JSONL
        const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);
        const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);
        // d. Determine detection mode
        const detectionMode = 'jsonl';
        // e. Register in store
        const projectName = path.basename(info.cwd);
        const session = {
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
            const summary = this.summarizer.summarize(change.to, { type: change.to === 'idle' ? 'assistant' : 'user', stopReason: change.to === 'idle' ? 'end_turn' : undefined }, []);
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
                const jp = this.jsonlPaths.get(info.sessionId);
                if (jp) {
                    void this.refreshGoalSummary(info.sessionId, jp);
                    void this.refreshContextSummary(info.sessionId, jp);
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
    async registerRemoteSession(info) {
        const compositeId = `${info.host}::${info.sessionId}`;
        // Find host config
        const hostConfig = this.config.hosts.find(h => h.name === info.host);
        if (!hostConfig)
            return;
        const remoteConfig = {
            sshTarget: hostConfig.ssh,
            sshOptions: hostConfig.ssh_options,
            claudeDir: hostConfig.claude_dir,
        };
        // Compute remote JSONL path
        const claudeDir = hostConfig.claude_dir ?? '~/.claude';
        const slug = cwdToSlug(info.cwd);
        const jsonlPath = `${claudeDir}/projects/${slug}/${info.sessionId}.jsonl`;
        // Cold start: read remote JSONL tail for initial state
        let initialState = 'idle';
        let lastTask;
        try {
            const tail = await remoteReadJsonlTail(remoteConfig, jsonlPath);
            // Parse the tail to determine state (reuse existing parsing logic)
            const lines = tail.split('\n').filter(l => l.trim());
            // Walk backwards like coldStartScan
            for (let i = lines.length - 1; i >= 0; i--) {
                const parsed = parseJsonlLine(lines[i]);
                if (!parsed)
                    continue;
                if (parsed.type === 'system' && (parsed.systemSubtype === 'turn_duration' || parsed.systemSubtype === 'stop_hook_summary')) {
                    initialState = 'idle';
                    break;
                }
                if (parsed.type === 'assistant') {
                    if (parsed.stopReason === 'end_turn') {
                        initialState = 'idle';
                        break;
                    }
                    if (parsed.stopReason === 'tool_use') {
                        initialState = 'executing';
                        break;
                    }
                    if (parsed.stopReason === null) {
                        initialState = 'thinking';
                        break;
                    }
                }
            }
            // Find last user task
            for (let i = lines.length - 1; i >= 0; i--) {
                const parsed = parseJsonlLine(lines[i]);
                if (parsed?.type === 'user' && parsed.userContent) {
                    const text = parsed.userContent.trim();
                    if (!isInternalMessage(text)) {
                        lastTask = cleanDisplayText(text).slice(0, 80);
                        break;
                    }
                }
            }
        }
        catch { }
        const projectName = info.cwd.split('/').pop() ?? info.cwd;
        const session = {
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
    startRemoteJsonlPoller(compositeId, config, jsonlPath) {
        const timer = setInterval(async () => {
            if (this.stopping)
                return;
            const session = this.store.get(compositeId);
            if (!session) {
                clearInterval(timer);
                return;
            }
            try {
                const tail = await remoteReadJsonlTail(config, jsonlPath);
                const lines = tail.split('\n').filter(l => l.trim());
                // Find the most recent state-determining message
                for (let i = lines.length - 1; i >= 0; i--) {
                    const parsed = parseJsonlLine(lines[i]);
                    if (!parsed)
                        continue;
                    const fsm = this.stateMachines.get(compositeId);
                    if (!fsm)
                        break;
                    if (parsed.type === 'user' && parsed.userContent) {
                        const text = parsed.userContent.trim();
                        if (!isInternalMessage(text)) {
                            this.store.update(compositeId, { currentTask: cleanDisplayText(text).slice(0, 80) });
                        }
                        break;
                    }
                    if (parsed.type === 'assistant' && parsed.stopReason !== undefined) {
                        fsm.transition({ type: 'jsonl', stopReason: parsed.stopReason });
                        break;
                    }
                }
            }
            catch { }
        }, 3000);
        this.remotePollers.set(compositeId, timer);
    }
    /** Immediate cleanup — no dead state, no 30s delay. Used for session migration (clear/resume). */
    cleanupSession(sessionId) {
        const session = this.store.get(sessionId);
        if (!session)
            return;
        const fsm = this.stateMachines.get(sessionId);
        if (fsm) {
            fsm.removeAllListeners();
            this.stateMachines.delete(sessionId);
        }
        this.jsonlWatcher.unwatch(sessionId);
        this.jsonlPaths.delete(sessionId);
        this.processMonitor.stopPolling(session.pid);
        const remoteTimer = this.remotePollers.get(sessionId);
        if (remoteTimer) {
            clearInterval(remoteTimer);
            this.remotePollers.delete(sessionId);
        }
        this.hookSidToSessionId.delete(sessionId);
        this.store.unregister(sessionId);
    }
    deregisterSession(sessionId) {
        const session = this.store.get(sessionId);
        if (!session)
            return;
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
    resolveSessionId(hookSid, hookCwd) {
        // 1. Direct match (hook sid === internal sessionId)
        if (this.stateMachines.has(hookSid))
            return hookSid;
        // 2. Cached reverse mapping from previous resolution
        const cached = this.hookSidToSessionId.get(hookSid);
        if (cached && this.stateMachines.has(cached))
            return cached;
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
    resolveSessionIdByCwd(hookCwd) {
        if (!hookCwd)
            return null;
        for (const session of this.store.getAll()) {
            if (session.cwd === hookCwd && session.status !== 'dead' && this.stateMachines.has(session.sessionId)) {
                logger.debug('tower: hook resolved by CWD (no session ID)', { sessionId: session.sessionId, cwd: hookCwd });
                return session.sessionId;
            }
        }
        return null;
    }
    handleHookEvent(event) {
        const hookSid = event.sid;
        if (!hookSid)
            return;
        // When CLAUDE_SESSION_ID is not available (sid='unknown'), resolve by CWD only
        const sessionId = hookSid === 'unknown'
            ? this.resolveSessionIdByCwd(event.cwd)
            : this.resolveSessionId(hookSid, event.cwd);
        if (!sessionId) {
            logger.info('tower: hook event for unknown session', { hookSid, event: event.event, cwd: event.cwd });
            // session-start from unknown session = likely /clear or new session — trigger immediate re-scan
            if (event.event === 'session-start') {
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
                // Clean up the old session immediately if it was dead
                if (dyingSession?.status === 'dead') {
                    this.cleanupSession(dyingSession.sessionId);
                }
                logger.info('tower: triggering re-scan for new session', { hookSid, cwd: event.cwd, migrateFrom: dyingSession?.sessionId });
                void this.discovery.scanOnce().then(async (sessions) => {
                    for (const info of sessions) {
                        if (!this.store.get(info.sessionId)) {
                            await this.registerSession(info);
                            // Apply migrated metadata
                            if (migratedMeta && info.cwd === event.cwd) {
                                const patch = {};
                                if (migratedMeta.label)
                                    patch['label'] = migratedMeta.label;
                                if (migratedMeta.tags)
                                    patch['tags'] = migratedMeta.tags;
                                if (migratedMeta.favorite) {
                                    patch['favorite'] = migratedMeta.favorite;
                                    patch['favoritedAt'] = migratedMeta.favoritedAt;
                                }
                                if (Object.keys(patch).length > 0) {
                                    this.store.update(info.sessionId, patch);
                                    logger.info('tower: migrated metadata via hook', { from: dyingSession?.sessionId, to: info.sessionId, keys: Object.keys(patch) });
                                }
                            }
                        }
                    }
                });
            }
            return;
        }
        logger.info('tower: hook event received', { event: event.event, sessionId, hookSid });
        const session = this.store.get(sessionId);
        if (session && session.detectionMode !== 'hook') {
            // Upgrade to hook mode on first hook event
            this.store.update(sessionId, { detectionMode: 'hook' });
        }
        const fsm = this.stateMachines.get(sessionId);
        if (!fsm)
            return;
        // Map hook event to FSM input
        const inputEvent = this.mapHookToInput(event);
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
    handleJsonlEvent(sessionId, parsed) {
        const session = this.store.get(sessionId);
        if (!session)
            return;
        // Skip JSONL-driven transitions if session is in hook mode
        if (session.detectionMode === 'hook')
            return;
        const fsm = this.stateMachines.get(sessionId);
        if (!fsm)
            return;
        // Map JSONL parsed message to FSM input + update live summary
        if (parsed.type === 'user') {
            const rawText = parsed.userContent?.trim() ?? '';
            if (!isInternalMessage(rawText)) {
                fsm.transition({ type: 'user-prompt' });
                const cleaned = cleanDisplayText(rawText);
                this.store.update(sessionId, {
                    messageCount: session.messageCount + 1,
                    currentTask: cleaned.slice(0, 80),
                    currentActivity: cleaned.slice(0, 60),
                });
                // LLM summaries are triggered on idle transition (state-change handler)
            }
        }
        else if (parsed.type === 'assistant') {
            if (parsed.stopReason === 'tool_use' && parsed.toolName) {
                fsm.transition({ type: 'jsonl', stopReason: 'tool_use' });
                const toolDesc = parsed.toolInput
                    ? `${parsed.toolName}: ${parsed.toolInput}`
                    : parsed.toolName;
                this.store.update(sessionId, {
                    toolCallCount: session.toolCallCount + 1,
                    currentActivity: toolDesc,
                });
            }
            else if (parsed.stopReason === 'end_turn') {
                fsm.transition({ type: 'jsonl', stopReason: 'end_turn' });
                const summary = parsed.assistantText
                    ? `✓ ${cleanDisplayText(parsed.assistantText).split('.')[0]?.slice(0, 60) ?? 'Done'}`
                    : '✓ Done';
                this.store.update(sessionId, { currentActivity: summary });
            }
            else if (parsed.stopReason === null) {
                fsm.transition({ type: 'jsonl', stopReason: null });
            }
        }
        else if (parsed.type === 'progress' && parsed.progressType === 'agent_progress') {
            fsm.transition({ type: 'agent-start' });
            this.store.update(sessionId, { currentTask: 'Subagent running...' });
        }
    }
    mapHookToInput(event) {
        switch (event.event) {
            case 'session-start': return { type: 'session-start' };
            case 'user-prompt': return { type: 'user-prompt' };
            case 'pre-tool': return { type: 'pre-tool' };
            case 'post-tool': return { type: 'post-tool' };
            case 'agent-start': return { type: 'agent-start' };
            case 'agent-stop': return { type: 'agent-stop' };
            case 'stop': return { type: 'stop' };
            case 'session-end': return { type: 'session-end' };
            default: return null;
        }
    }
    getStateMachine(sessionId) {
        return this.stateMachines.get(sessionId);
    }
}
//# sourceMappingURL=tower.js.map