import { describe, it, expect, afterEach } from 'vitest';
import { HookReceiver } from '../../src/core/hook-receiver.js';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('HookReceiver', () => {
  const socketPath = path.join(os.tmpdir(), `cc-tower-test-${process.pid}.sock`);
  let receiver: HookReceiver;

  afterEach(async () => {
    if (receiver) await receiver.stop();
    try { fs.unlinkSync(socketPath); } catch {}
  });

  it('starts and listens on Unix socket', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();
    // Socket file should exist
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('receives and parses a valid HookEvent', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();

    const event = await new Promise<any>((resolve) => {
      receiver.on('hook-event', resolve);

      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({
          event: 'pre-tool',
          sid: 'test-session-123',
          cwd: '/home/user/project',
          ts: Date.now(),
          context: { toolName: 'Bash' }
        }) + '\n');
        client.end();
      });
    });

    expect(event.event).toBe('pre-tool');
    expect(event.sid).toBe('test-session-123');
    expect(event.context.toolName).toBe('Bash');
  });

  it('ignores malformed JSON', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();

    let received = false;
    receiver.on('hook-event', () => { received = true; });

    await new Promise<void>((resolve) => {
      const client = net.createConnection(socketPath, () => {
        client.write('not valid json\n');
        client.end();
        setTimeout(() => resolve(), 100);
      });
    });

    expect(received).toBe(false);
  });

  it('handles multiple events on one connection', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();

    const events: any[] = [];
    receiver.on('hook-event', (e) => events.push(e));

    await new Promise<void>((resolve) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ event: 'user-prompt', sid: 's1', ts: 1 }) + '\n');
        client.write(JSON.stringify({ event: 'stop', sid: 's1', ts: 2 }) + '\n');
        client.end();
        setTimeout(() => resolve(), 100);
      });
    });

    expect(events.length).toBe(2);
    expect(events[0].event).toBe('user-prompt');
    expect(events[1].event).toBe('stop');
  });

  it('cleans up stale socket on start', async () => {
    // Create a stale socket file
    fs.writeFileSync(socketPath, '');

    receiver = new HookReceiver(socketPath);
    await receiver.start();
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('emits query event (not hook-event) for query messages', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();

    const hookEvents: any[] = [];
    receiver.on('hook-event', (e) => hookEvents.push(e));

    const queryConn = await new Promise<net.Socket>((resolve) => {
      receiver.once('query', (conn: net.Socket) => resolve(conn));

      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ event: 'query' }) + '\n');
        client.end();
      });
    });

    // query event provides the connection socket
    expect(queryConn).toBeDefined();
    // hook-event must NOT have been emitted
    expect(hookEvents).toHaveLength(0);
  });

  it('responds to query via the connection socket', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();

    // Simulate Tower responding with session data
    receiver.once('query', (conn: net.Socket) => {
      conn.write(JSON.stringify([{ sessionId: 'abc', status: 'idle' }]) + '\n');
      conn.end();
    });

    const response = await new Promise<string>((resolve) => {
      let data = '';
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ event: 'query' }) + '\n');
        client.end();
      });
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => resolve(data.trim()));
      client.on('error', () => resolve(''));
    });

    const parsed = JSON.parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe('abc');
    expect(parsed[0].status).toBe('idle');
  });

  it('removes socket file on stop', async () => {
    receiver = new HookReceiver(socketPath);
    await receiver.start();
    await receiver.stop();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
