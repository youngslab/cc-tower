import { describe, it, expect } from 'vitest';
import { ProcessMonitor } from '../../src/core/process-monitor.js';

describe('ProcessMonitor', () => {
  it('checkOnce returns alive=true for current process', async () => {
    const monitor = new ProcessMonitor();
    const result = await monitor.checkOnce(process.pid);
    expect(result.alive).toBe(true);
  });

  it('checkOnce returns alive=false for non-existent PID', async () => {
    const monitor = new ProcessMonitor();
    const result = await monitor.checkOnce(999999);
    expect(result.alive).toBe(false);
  });

  it('checkOnce returns childCount >= 0', async () => {
    const monitor = new ProcessMonitor();
    const result = await monitor.checkOnce(process.pid);
    expect(result.childCount).toBeGreaterThanOrEqual(0);
  });
});
