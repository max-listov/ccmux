import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CodexControlClient,
  type CodexControlConnection,
  createCodexDriver,
} from 'stitchkit/agent-executor/codex';
import { z } from 'zod';
import type { ResolvedControlLaunch } from '../../config/launchRecipes.ts';
import { privateRuntimeDirectory } from '../../runtime/store.ts';
import type { MachineConfig } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { executorProfileEnv, sessionEnvRecipe } from '../launch/sessionEnv.ts';
import { ownedChildAlive } from './owned/child.ts';
import { ownedCodexFlags } from './owned/launch.ts';

const NativeConfigSchema = z.object({
  config: z.object({
    model_provider: z.string().min(1).max(128).nullable().optional(),
  }),
});

/** Native configuration, not a caller-provided endpoint, owns provider identity. */
export async function nativeModelProvider(
  controls: Pick<CodexControlClient, 'readConfig'>,
  cwd?: string,
): Promise<string> {
  const read = NativeConfigSchema.parse(
    await controls.readConfig({
      includeLayers: false,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
  return read.config.model_provider ?? 'openai';
}

/** The socket directory of a catalog read, named after the process that made it. Short and in
 * `/tmp` because a unix socket path is limited to about a hundred bytes. */
const CATALOG_ROOT_PARENT = '/tmp';
const CATALOG_ROOT = /^stitchmux-catalog-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * Remove the directories of catalog reads whose process is gone.
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

/**
 * A bounded metadata process backed by `stitchkit/agent-executor/codex` (`unix-listen` +
 * `connectControl`): no conversation, TUI, registration or writer, reaped on every exit including
 * owner-loss SIGKILL.
 */
export async function withCodexCatalogRuntime<T>(
  m: MachineConfig,
  launch: ResolvedControlLaunch,
  cwd: string,
  signal: AbortSignal,
  read: (controls: CodexControlConnection) => Promise<T>,
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
  const root = mkdtempSync(join(CATALOG_ROOT_PARENT, `stitchmux-catalog-${process.pid}-`));
  privateRuntimeDirectory(root);
  const socket = join(root, 'rpc.sock');
  let connection: CodexControlConnection | undefined;
  try {
    const driver = createCodexDriver({
      executable: m.codexBin,
      transport: { kind: 'unix-listen', socketPath: socket },
      serverArgs: flags,
      ambient: recipe.env,
    });
    connection = await driver.connectControl({
      profile: {
        engine: 'codex',
        profileId: 'catalog',
        home: m.codexHome,
        env: executorProfileEnv(recipe.env),
      },
      cwd,
      signal,
    });
    return await read(connection);
  } catch (error) {
    const directory = join(m.stateDir, 'control');
    privateRuntimeDirectory(directory);
    await atomicWrite(
      join(directory, 'catalog-diagnostic.json'),
      JSON.stringify({
        observedAt: new Date().toISOString(),
        reason: String(error).slice(0, 2_048),
        stderr: '',
      }),
      0o600,
    );
    throw error;
  } finally {
    try {
      await connection?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
