import { execa } from 'execa';
import { EventEmitter } from 'node:events';
export class ProcessMonitor extends EventEmitter {
    intervals = new Map();
    async checkOnce(pid) {
        try {
            process.kill(pid, 0);
        }
        catch {
            return { alive: false, childCount: 0 };
        }
        try {
            const { stdout } = await execa('ps', ['--ppid', String(pid), '-o', 'pid=']);
            const children = stdout.trim().split('\n').filter(Boolean);
            return { alive: true, childCount: children.length };
        }
        catch {
            return { alive: true, childCount: 0 };
        }
    }
    startPolling(pid, interval = 5000) {
        if (this.intervals.has(pid))
            return;
        const timer = setInterval(async () => {
            const state = await this.checkOnce(pid);
            this.emit('process-state', { pid, ...state });
            if (!state.alive) {
                this.stopPolling(pid);
                this.emit('process-died', { pid });
            }
        }, interval);
        this.intervals.set(pid, timer);
    }
    stopPolling(pid) {
        const timer = this.intervals.get(pid);
        if (timer) {
            clearInterval(timer);
            this.intervals.delete(pid);
        }
    }
    stopAll() {
        for (const [pid] of this.intervals) {
            this.stopPolling(pid);
        }
    }
}
//# sourceMappingURL=process-monitor.js.map