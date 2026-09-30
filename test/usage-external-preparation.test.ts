import { expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { UsagePreparation } from '../src/usage/preparation.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { readSessionUsage } from '../src/usage/service.ts';
import { makeMachine, makeSession } from './helpers.ts';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const record = (n: number) =>
  `${JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-01-01T00:00:00Z',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: n, output_tokens: 5, total_tokens: n + 5 } },
    },
  })}\n`;

test('external source skips prepared work, catches append/archive, and never bypasses permissions or identity', async () => {
  const root = mkdtempSync('/tmp/ccmux-external-usage-gate-');
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions);
    const path = join(sessions, `rollout-test-${id}.jsonl`);
    const body = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } })}\n${record(10)}`;
    writeFileSync(path, body, { mode: 0o600 });
    const m = makeMachine({ stateDir: root, codexSessionsDir: sessions, rcPrefix: 'host-a' });
    const gate = new UsagePreparation();
    const address = `host-a:app/${id}`;
    const inspect = (inventory: ReturnType<typeof makeSession>[] = []) =>
      gate.inspectExternal(m, id, address, new AbortController().signal, inventory);
    const read = () => readSessionUsage(m, address, UsageQuerySchema.parse({}), true);
    const work = await inspect();
    expect(work?.needed).toBe(true);
    const result = await read();
    expect(result.self.values.inputTokens).toBe(10);
    work?.complete(result);
    expect((await inspect())?.needed).toBe(false);
    appendFileSync(path, record(20));
    expect((await inspect())?.needed).toBe(true);
    const appended = await inspect();
    appended?.complete(await read());
    expect((await inspect())?.needed).toBe(false);
    const archive = join(root, 'archived_sessions');
    mkdirSync(archive);
    renameSync(path, join(archive, `rollout-test-${id}.jsonl`));
    expect((await inspect())?.needed).toBe(true);
    const archived = await inspect();
    archived?.complete(await read());
    expect((await inspect())?.needed).toBe(false);
    const archivedPath = join(archive, `rollout-test-${id}.jsonl`);
    chmodSync(archivedPath, 0o622);
    expect(await inspect()).toBeNull();
    chmodSync(archivedPath, 0o600);
    const before = statSync(archivedPath);
    writeFileSync(archivedPath, readFileSync(archivedPath, 'utf8').replace(id, other));
    utimesSync(archivedPath, before.atime, before.mtime);
    expect(await inspect()).toBeNull();
    writeFileSync(archivedPath, body);
    expect((await inspect())?.needed).toBe(true);
    await expect(inspect([makeSession({ agent: 'codex', uuid: id })])).rejects.toThrow(
      'managed session address',
    );
    renameSync(archivedPath, join(root, 'outside'));
    symlinkSync(join(root, 'outside'), archivedPath);
    expect(await inspect()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
