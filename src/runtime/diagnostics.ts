import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';

/** Exact native causes are private owner evidence, never API errors or stderr mirrors. */
export async function recordRuntimeDiagnostic(
  m: MachineConfig,
  name: string | null,
  stage: string,
  error: unknown,
  stderr?: string,
): Promise<void> {
  const root = join(m.stateDir, 'native-diagnostics');
  privateRuntimeDirectory(root);
  // Keyed by session AND stage. With the session alone, one file held every stage and the last
  // writer won — so a generic wrapper written a moment after the informative cause destroyed it,
  // and the only record left said "requires reconciliation" without saying of what.
  const key = createHash('sha256')
    .update(`${name ?? 'host-catalog'}\u0000${stage}`)
    .digest('hex')
    .slice(0, 32);
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : (JSON.stringify(error) ?? String(error));
  await atomicWrite(
    join(root, `${key}.json`),
    JSON.stringify({
      at: new Date().toISOString(),
      // The file is named by a hash of session and stage, which is unambiguous and unreadable. The
      // session is written inside so the record can be found by the name an operator actually has.
      name,
      stage,
      detail: detail.slice(-32_768),
      stderr: stderr?.slice(-32_768) ?? null,
    }),
    0o600,
  );
}

export const RuntimeDiagnosticSchema = z.object({
  at: z.string(),
  name: z.string().nullable().default(null),
  stage: z.string(),
  detail: z.string(),
  stderr: z.string().nullable().default(null),
});
export type RuntimeDiagnostic = z.infer<typeof RuntimeDiagnosticSchema>;

/**
 * Every diagnostic recorded for one session, newest first, and a count of the records that cannot
 * be attributed to any session at all.
 *
 * These are owner-private evidence and stay that way — the directory is 0700 and nothing here
 * crosses a wire. But private to the owner is not the same as unreachable BY the owner, and it had
 * become the second: a session blocked with "owner diagnostic recorded", and the record it named
 * sat under a filename that is a hash of the session and the stage, with the stage printed nowhere.
 *
 * Records written before the session name was stored inside are counted, never claimed. Whose they
 * are is not recoverable — the hash is one-way, and the stage vocabulary is scattered across call
 * sites rather than declared in one place, so it cannot be enumerated to invert. Reporting them as
 * "none recorded" would answer "there is no evidence" to a question that means "I could not read
 * it", which is the same conflation this reader exists to end.
 */
export async function readRuntimeDiagnostics(
  m: MachineConfig,
  name: string,
): Promise<{ matched: RuntimeDiagnostic[]; unattributed: number }> {
  const root = join(m.stateDir, 'native-diagnostics');
  if (!existsSync(root)) return { matched: [], unattributed: 0 };
  const matched: RuntimeDiagnostic[] = [];
  let unattributed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let parsed: RuntimeDiagnostic;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(root, entry.name), 'utf8'));
      const result = RuntimeDiagnosticSchema.safeParse(raw);
      if (!result.success) continue;
      parsed = result.data;
    } catch {
      continue;
    }
    if (parsed.name === name) matched.push(parsed);
    else if (parsed.name === null) unattributed += 1;
  }
  matched.sort((a, b) => b.at.localeCompare(a.at));
  return { matched, unattributed };
}

/** Drain the child continuously without exposing raw output or accumulating an unbounded log. */
export function captureNativeStderr(stream: ReadableStream<Uint8Array>) {
  let tail = Buffer.alloc(0);
  const closed = (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        tail = Buffer.concat([tail, next.value]).subarray(-32_768);
      }
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => {
    tail = Buffer.from(`Native stderr read failed: ${String(error).slice(-8_192)}`);
  });
  return { text: () => tail.toString('utf8'), closed };
}
