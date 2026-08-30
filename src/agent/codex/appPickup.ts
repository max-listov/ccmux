import { createReadStream } from 'node:fs';
import { Glob } from 'bun';
import type { MachineConfig } from '../../types.ts';

async function fileContains(path: string, needle: Buffer): Promise<boolean> {
  let carry = Buffer.alloc(0);
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    if (data.indexOf(needle) !== -1) return true;
    carry = data.subarray(Math.max(0, data.length - needle.length + 1));
  }
  return false;
}

/** Exact persisted acceptance proof for a turn/start client id. Used only after a pre-submit pickup
 * barrier survives a restart, so ordinary first delivery never scans a long transcript. */
export async function codexAppMessagePersisted(
  m: MachineConfig,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  if (!m.codexSessionsDir) return false;
  const glob = new Glob(`**/*-${threadId}.jsonl`);
  const needle = Buffer.from(`"client_id":"${messageId}"`);
  for (const path of glob.scanSync({ cwd: m.codexSessionsDir, absolute: true })) {
    if (await fileContains(path, needle)) return true;
  }
  return false;
}
