import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';
import { z } from 'zod';
import type { ResolvedControlLaunch } from '../../config/launchRecipes.ts';
import { privateRuntimeDirectory } from '../../runtime/store.ts';
import type { MachineConfig } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { sessionEnvRecipe } from '../launch/sessionEnv.ts';
import { ownedChildAlive } from './owned/child.ts';
import { ownedCodexFlags } from './owned/launch.ts';
import type { CodexAppRpc } from './rpc.ts';
import { connectCodexSocket } from './socket.ts';

const NativeConfigSchema = z.object({
  config: z.object({
    model_provider: z.string().min(1).max(128).nullable().optional(),
  }),
});

/** Native configuration, not a caller-provided endpoint, owns provider identity. */
export async function nativeModelProvider(rpc: CodexAppRpc, cwd?: string): Promise<string> {
  const read = NativeConfigSchema.parse(
    await rpc.request('config/read', {
      includeLayers: false,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
  return read.config.model_provider ?? 'openai';
}

/** The socket directory of a catalog read, named after the process that made it. Short and in
 * `/tmp` because a unix socket path is limited to about a hundred bytes. */
const CATALOG_ROOT_PARENT = '/tmp';
const CATALOG_ROOT = /^ccmux-catalog-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Remove the directories of catalog reads whose process is gone. The read removes its own on every
 * exit it lives through, but a SIGKILL, an OOM kill or a forced exit skips that, and each one left an
 * empty directory in `/tmp` for good — one per killed daemon, measured across full test runs. The
 * name carries the creator's pid, so the next read can tell an abandoned directory from a live one
 * without guessing by age.
 */
export function sweepAbandonedCatalogRoots(
  parent = CATALOG_ROOT_PARENT,
  alive: (pid: number) => boolean = ownedChildAlive,
): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    const pid = Number(CATALOG_ROOT.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Another user's directory in a sticky /tmp is theirs to remove.
    }
  }
  return removed;
}

/** A bounded metadata process has no conversation, TUI, registration or writer. It uses the same
 * native flag and session-environment contracts as managed execution and is reaped on every exit. */
export async function withCodexCatalogRuntime<T>(
  m: MachineConfig,
  launch: ResolvedControlLaunch,
  cwd: string,
  signal: AbortSignal,
  read: (rpc: CodexAppRpc) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (!m.codexBin || !m.codexHome) throw new Error('Codex catalog runtime is not configured');
  const flags = ownedCodexFlags([...launch.flags, ...m.extraFlags]).server;
  const recipe = sessionEnvRecipe(
    { dir: cwd, ...(launch.envFile === undefined ? {} : { envFile: launch.envFile }) },
    process.env,
    process.env.NODE_ENV,
  );
  if (recipe.refused.length) throw new Error('Catalog environment contains reserved names');
  sweepAbandonedCatalogRoots();
  const root = mkdtempSync(join(CATALOG_ROOT_PARENT, `ccmux-catalog-${process.pid}-`));
  const socket = join(root, 'rpc.sock');
  let rpc: CodexAppRpc | undefined;
  const disposal = new AbortController();
  const stopReason = new Error('Catalog read completed');
  const lifetime = AbortSignal.any([signal, disposal.signal]);
  let command: Promise<never> | undefined;
  let diagnostic = Buffer.alloc(0);
  try {
    command = runNativeCommand({
      executable: m.codexBin,
      args: ['app-server', '--listen', `unix://${socket}`, ...flags],
      cwd,
      env: { ...recipe.env, CODEX_HOME: m.codexHome },
      signal: lifetime,
      ownerLoss: 'terminate',
      stop: { target: 'group', graceMs: 2_000 },
      onOutput(bytes, channel) {
        // Only a bounded private tail survives; provider output never reaches public responses.
        if (channel === 'stderr') diagnostic = Buffer.concat([diagnostic, bytes]).subarray(-16_384);
      },
    }).then((result) => {
      throw new Error(`Catalog runtime exited (${result.exitCode}, ${result.signal})`);
    });
    return await Promise.race([
      command,
      (async () => {
        while (!existsSync(socket)) {
          lifetime.throwIfAborted();
          await Bun.sleep(20);
        }
        lifetime.throwIfAborted();
        rpc = await connectCodexSocket(socket, {
          signal: lifetime,
          maxMessageBytes: 2 * 1024 * 1024,
        });
        return await read(rpc);
      })(),
    ]);
  } catch (error) {
    const directory = join(m.stateDir, 'control');
    privateRuntimeDirectory(directory);
    await atomicWrite(
      join(directory, 'catalog-diagnostic.json'),
      JSON.stringify({
        observedAt: new Date().toISOString(),
        reason: String(error).slice(0, 2_048),
        stderr: diagnostic.toString('utf8'),
      }),
      0o600,
    );
    throw error;
  } finally {
    rpc?.close();
    disposal.abort(stopReason);
    try {
      await command?.catch((error: unknown) => {
        if (error !== stopReason && error !== signal.reason) throw error;
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
