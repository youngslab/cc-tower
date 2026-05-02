import { describe, it, expect, afterEach } from 'vitest';
import { HookReceiver } from '../../src/core/hook-receiver.js';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Plan v2 §3.4 dual-socket: HookReceiver listens on both popmux.sock (new)
 * and cc-tower.sock (legacy) during the 14-day deprecation window. Payloads
 * from either socket must reach the same hook-event listener so the existing
 * SessionStateMachine routing keeps working unchanged.
 */
describe('HookReceiver — dual-socket (Plan v2 §3.4)', () => {
  const tmp = os.tmpdir();
  const popmuxSock = path.join(tmp, `popmux-test-${process.pid}.sock`);
  const legacySock = path.join(tmp, `cc-tower-test-${process.pid}.sock`);
  let receiver: HookReceiver;

  afterEach(async () => {
    if (receiver) await receiver.stop();
    for (const p of [popmuxSock, legacySock]) {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('binds both socket paths and reports them via getSocketPaths()', async () => {
    receiver = new HookReceiver([popmuxSock, legacySock]);
    await receiver.start();
    expect(fs.existsSync(popmuxSock)).toBe(true);
    expect(fs.existsSync(legacySock)).toBe(true);
    expect(receiver.getSocketPaths()).toEqual([popmuxSock, legacySock]);
  });

  it('routes events from popmux.sock to the same hook-event listener', async () => {
    receiver = new HookReceiver([popmuxSock, legacySock]);
    await receiver.start();

    const event = await new Promise<any>((resolve) => {
      receiver.on('hook-event', resolve);
      const client = net.createConnection(popmuxSock, () => {
        client.write(JSON.stringify({ event: 'pre-tool', sid: 'sid-popmux', ts: 1 }) + '\n');
        client.end();
      });
    });

    expect(event.sid).toBe('sid-popmux');
  });

  it('routes events from cc-tower.sock (legacy) to the same hook-event listener', async () => {
    receiver = new HookReceiver([popmuxSock, legacySock]);
    await receiver.start();

    const event = await new Promise<any>((resolve) => {
      receiver.on('hook-event', resolve);
      const client = net.createConnection(legacySock, () => {
        client.write(JSON.stringify({ event: 'pre-tool', sid: 'sid-legacy', ts: 2 }) + '\n');
        client.end();
      });
    });

    expect(event.sid).toBe('sid-legacy');
  });

  it('aggregates events from both sockets into one listener', async () => {
    receiver = new HookReceiver([popmuxSock, legacySock]);
    await receiver.start();

    const events: any[] = [];
    receiver.on('hook-event', (e) => events.push(e));

    await new Promise<void>((resolve) => {
      const a = net.createConnection(popmuxSock, () => {
        a.write(JSON.stringify({ event: 'user-prompt', sid: 'A', ts: 1 }) + '\n');
        a.end();
      });
      a.on('end', () => {
        const b = net.createConnection(legacySock, () => {
          b.write(JSON.stringify({ event: 'stop', sid: 'B', ts: 2 }) + '\n');
          b.end();
        });
        b.on('end', () => setTimeout(resolve, 50));
      });
    });

    const sids = events.map(e => e.sid).sort();
    expect(sids).toEqual(['A', 'B']);
  });

  it('removes both socket files on stop', async () => {
    receiver = new HookReceiver([popmuxSock, legacySock]);
    await receiver.start();
    await receiver.stop();
    expect(fs.existsSync(popmuxSock)).toBe(false);
    expect(fs.existsSync(legacySock)).toBe(false);
  });

  it('dedupes when the same path is passed twice', async () => {
    receiver = new HookReceiver([popmuxSock, popmuxSock]);
    await receiver.start();
    expect(receiver.getSocketPaths()).toEqual([popmuxSock]);
  });

  it('accepts a single string for back-compat', async () => {
    receiver = new HookReceiver(popmuxSock);
    await receiver.start();
    expect(receiver.getSocketPaths()).toEqual([popmuxSock]);
    expect(fs.existsSync(popmuxSock)).toBe(true);
  });

  it('filters out empty / falsy paths from the list', async () => {
    receiver = new HookReceiver([popmuxSock, '', legacySock]);
    await receiver.start();
    expect(receiver.getSocketPaths()).toEqual([popmuxSock, legacySock]);
  });
});
