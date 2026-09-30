import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RuntimeStatusWriter } from '../src/runtime/statusFile.ts';

test('every heartbeat remains fresh; state changes and disconnect publish immediately', async () => {
  const root = mkdtempSync('/tmp/ccmux-heartbeat-');
  const path = join(root, 'status.json');
  const schema = z.object({
    pid: z.number(),
    providerPid: z.number(),
    connected: z.boolean(),
    reason: z.string().nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    sequence: z.number(),
    state: z.string(),
  });
  const writer = new RuntimeStatusWriter(path, schema);
  const base = {
    pid: process.pid,
    providerPid: process.pid,
    connected: true,
    reason: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    sequence: 1,
    state: 'idle',
  };
  try {
    await writer.write(base);
    const first = readFileSync(path, 'utf8');
    await writer.write({
      ...base,
      sequence: 2,
      observedAt: new Date(Date.now() + 1).toISOString(),
    });
    expect(readFileSync(path, 'utf8')).not.toBe(first);
    expect(JSON.parse(readFileSync(path, 'utf8')).sequence).toBe(2);
    await writer.write({ ...base, sequence: 3, state: 'working' });
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('working');
    await writer.write({ ...base, sequence: 4, connected: false, reason: 'disconnected' });
    expect(JSON.parse(readFileSync(path, 'utf8')).connected).toBe(false);
    await expect(writer.write({ ...base, observedAt: 'invalid' })).rejects.toThrow();
    await writer.write(base);
    const renewed = {
      ...base,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    };
    await writer.write(renewed);
    expect(JSON.parse(readFileSync(path, 'utf8')).observedAt).toBe(renewed.observedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
