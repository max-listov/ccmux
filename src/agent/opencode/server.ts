import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { z } from 'zod';
import { CHAT_CREDENTIAL_ENV } from '../../chat/auth.ts';
import { captureNativeStderr, recordRuntimeDiagnostic } from '../../runtime/diagnostics.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { compareSemver } from '../../util/version.ts';
import { stopOwnedChildGroup } from '../codex/ownedChild.ts';
import { sessionEnvRecipe } from '../sessionEnv.ts';
import { boundedOpenCodeFetch } from './http.ts';

const HealthSchema = z.object({ healthy: z.literal(true), version: z.string().min(1).max(64) });

/** The native schema is pinned; older native servers must not silently drop correlation metadata. */
export function preflightOpenCode(m: MachineConfig): void {
  if (m.opencodeBin === undefined) throw new Error('OpenCode executable is not configured');
  const result = Bun.spawnSync([m.opencodeBin, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
  const version = result.stdout.toString().trim();
  if (
    result.exitCode !== 0 ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    compareSemver(version, '1.18.20') < 0
  )
    throw new Error('Managed OpenCode requires version 1.18.20 or newer');
}

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else if (address === null || typeof address === 'string')
          reject(new Error('No loopback listener address'));
        else resolve(address.port);
      });
    });
  });
}

/** Only this scope can stop the child. Authentication prevents a port-reuse race attaching another server. */
export async function startOpenCodeServer(
  m: MachineConfig,
  session: Pick<Session, 'dir' | 'envFile'>,
  signal: AbortSignal,
  identity?: { name: string; credential: string },
) {
  preflightOpenCode(m);
  if (m.opencodeBin === undefined) throw new Error('OpenCode executable is not configured');
  const port = await ephemeralPort();
  signal.throwIfAborted();
  const password = randomBytes(32).toString('base64url');
  const env = sessionEnvRecipe(session, process.env, process.env.NODE_ENV);
  if (env.refused.length) throw new Error('Declared environment contains reserved names');
  delete env.env.CCMUX_SESSION;
  delete env.env[CHAT_CREDENTIAL_ENV];
  if (identity) {
    env.env.CCMUX_SESSION = identity.name;
    env.env[CHAT_CREDENTIAL_ENV] = identity.credential;
  }
  const child = Bun.spawn(
    [m.opencodeBin, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: session.dir,
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...env.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    },
  );
  const stderr = captureNativeStderr(child.stderr);
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    directory: session.dir,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
    fetch: boundedOpenCodeFetch,
    throwOnError: true,
  });
  let stopped = false;
  const close = async () => {
    if (!stopped) {
      stopped = true;
      await stopOwnedChildGroup(child);
      await stderr.closed;
    }
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error('Native server exited before readiness');
      try {
        const health = HealthSchema.parse(
          (
            await client.global.health({
              signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
            })
          ).data,
        );
        if (child.exitCode !== null) throw new Error('Native server exited during readiness');
        return { client, child, version: health.version, close, stderr: stderr.text };
      } catch (error) {
        if (Date.now() + 100 >= deadline) throw error;
        await Bun.sleep(100);
      }
    }
    throw new Error('Native server readiness expired');
  } catch (error) {
    await close();
    await recordRuntimeDiagnostic(
      m,
      identity?.name ?? null,
      'server-readiness',
      error,
      stderr.text(),
    );
    throw new Error('Native server could not become ready');
  }
}

export type OpenCodeServer = Awaited<ReturnType<typeof startOpenCodeServer>>;
export type OpenCodeClient = OpenCodeServer['client'];
