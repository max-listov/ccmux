import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCodeConnection } from '../src/agent/opencode/connection.ts';
import { readContent } from '../src/content/read.ts';
import { ContentWriter } from '../src/content/store.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('OpenCode persists its content baseline before enabling native callbacks', async () => {
  for (const failWrite of [false, true]) {
    const m = makeMachine({ stateDir: mkdtempSync('/tmp/ccmux-content-ready-') });
    const session = makeSession({
      agent: 'opencode',
      runtime: 'native',
      registrationGeneration: crypto.randomUUID(),
      nativeSession: { runtime: 'opencode', id: 'ses_fixture', version: '1.18.20' },
    });
    const abort = new AbortController();
    const baselineReads: boolean[] = [];
    const client = createOpencodeClient({
      baseUrl: 'http://127.0.0.1:1',
      throwOnError: true,
      fetch: Object.assign(
        async () => {
          try {
            baselineReads.push(readContent(m, session).target.threadId === session.uuid);
          } catch {
            baselineReads.push(false);
          }
          abort.abort();
          throw new Error('fixture native boundary reached');
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const child = Bun.spawn([process.execPath, '-e', ''], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await child.exited;
    const connection = new OpenCodeConnection(m, session, {
      client,
      child,
      version: '1.18.20',
      close: async () => {},
      stderr: () => '',
    });
    const flush = failWrite
      ? spyOn(ContentWriter.prototype, 'flushPending').mockRejectedValue(
          new Error('fixture write refused'),
        )
      : null;
    try {
      await expect(connection.open(abort.signal)).rejects.toBeDefined();
      if (failWrite) expect(baselineReads).toHaveLength(0);
      else {
        expect(baselineReads.length).toBeGreaterThan(0);
        expect(baselineReads.every(Boolean)).toBe(true);
      }
    } finally {
      flush?.mockRestore();
      abort.abort();
      await connection.close('stopped');
    }
  }
});
