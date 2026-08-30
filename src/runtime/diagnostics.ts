import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
  const key = createHash('sha256')
    .update(name ?? 'host-catalog')
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
      stage,
      detail: detail.slice(-32_768),
      stderr: stderr?.slice(-32_768) ?? null,
    }),
    0o600,
  );
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
