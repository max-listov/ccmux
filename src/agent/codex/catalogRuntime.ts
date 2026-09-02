import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResolvedControlLaunch } from '../../config/launchRecipes.ts';
import type { MachineConfig } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { sessionEnvRecipe } from '../sessionEnv.ts';
import { stopOwnedChildGroup } from './ownedChild.ts';
import { ownedCodexFlags } from './ownedLaunch.ts';
import { privateRuntimeDirectory } from './ownedPaths.ts';
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
  const root = mkdtempSync('/tmp/ccmux-catalog-');
  const socket = join(root, 'rpc.sock');
  let rpc: CodexAppRpc | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let drain: Promise<void> | undefined;
  let diagnostic = Buffer.alloc(0);
  try {
    const spawned = Bun.spawn(
      [m.codexBin, 'app-server', '--listen', `unix://${socket}`, ...flags],
      {
        cwd,
        env: { ...recipe.env, CODEX_HOME: m.codexHome },
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    child = spawned;
    // Keep only a bounded private tail. Provider output never enters public responses or stderr logs.
    drain = (async () => {
      for await (const bytes of spawned.stderr)
        diagnostic = Buffer.concat([diagnostic, bytes]).subarray(-16_384);
    })();
    while (!existsSync(socket)) {
      signal.throwIfAborted();
      if (spawned.exitCode !== null)
        throw new Error(`Catalog runtime exited (${spawned.exitCode})`);
      await Bun.sleep(20);
    }
    rpc = await connectCodexSocket(socket, { signal, maxMessageBytes: 2 * 1024 * 1024 });
    return await read(rpc);
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
    if (child !== undefined) await stopOwnedChildGroup(child);
    await drain;
    rmSync(root, { recursive: true, force: true });
  }
}
