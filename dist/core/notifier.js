import { EventEmitter } from 'node:events';
import notifier from 'node-notifier';
import { logger } from '../utils/logger.js';
export class Notifier extends EventEmitter {
    config;
    store;
    lastNotification = new Map(); // sessionId → timestamp
    focused = true;
    constructor(config, store) {
        super();
        this.config = config;
        this.store = store;
    }
    setFocused(focused) {
        this.focused = focused;
    }
    onStateChange(change) {
        if (!this.config.enabled)
            return;
        const session = this.store.getBySessionId(change.sessionId);
        if (!session)
            return;
        // Exception alerts: always fire regardless of conditions
        if (change.to === 'dead' && this.config.alerts.on_session_death) {
            this.notify(session, `Session "${session.label ?? session.projectName}" died`, 'error');
            return;
        }
        // Normal completion notification: thinking/executing/agent → idle
        if (change.to === 'idle' && ['thinking', 'executing', 'agent'].includes(change.from)) {
            // Check conditions
            if (!this.shouldNotify(change, session))
                return;
            const taskDesc = session.currentSummary?.summary ?? session.currentTask ?? 'Task completed';
            const duration = formatDuration(change.duration);
            this.notify(session, `✓ ${session.label ?? session.projectName} (${duration})\n${taskDesc}`, 'info');
        }
    }
    shouldNotify(change, session) {
        // 1. Turn duration >= min_duration
        if (change.duration < this.config.min_duration * 1000)
            return false;
        // 2. Dashboard not focused (suppress_when_focused)
        if (this.config.suppress_when_focused && this.focused)
            return false;
        // 3. Cooldown
        const lastTime = this.lastNotification.get(session.sessionId) ?? 0;
        if (Date.now() - lastTime < this.config.cooldown * 1000)
            return false;
        return true;
    }
    notify(session, message, level) {
        this.lastNotification.set(session.sessionId, Date.now());
        if (this.config.channels.desktop) {
            try {
                notifier.notify({
                    title: 'popmux',
                    message,
                    sound: this.config.channels.sound,
                });
            }
            catch (err) {
                logger.warn('notifier: desktop notification failed', { error: String(err) });
            }
        }
        if (this.config.channels.tmux_bell) {
            // tmux bell is handled via tmux display-message in the UI layer
            this.emit('notification', { session, message, level });
        }
        logger.info('notifier: sent', { sessionId: session.sessionId, message: message.slice(0, 80) });
    }
}
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}
//# sourceMappingURL=notifier.js.map