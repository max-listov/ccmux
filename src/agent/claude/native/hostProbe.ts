import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AppError } from 'stitchkit';
import type { ControlModel } from '../../../control/schema.ts';
import type { MachineConfig } from '../../../types.ts';
import { claudeModels, type SupportedModel } from './catalog.ts';
import { resolveAgentSdk } from './resolve.ts';

/**
 * Ask the installation itself what it offers, without conducting a conversation.
 *
 * A caller must choose a model BEFORE the create that would produce the first publisher, so on a
 * host that has never held this runtime the protocol closed a circle with no way out: the list
 * needed a session and the session needed the list, and the only exit was a command typed on the
 * machine. The circle was never real. The list is not a property of a conversation — it is what the
 * installed CLI and the operator's settings offer — and the runtime answers it on a connection that
 * has been given no turn.
 *
 * So this opens one, asks, and closes it. The prompt is an iterable that never yields: nothing is
 * ever sent, no conversation is created, and the child is closed in a `finally`. Measured on a host
 * with the mode enabled: 3.5 s to the answer, and no directory added under the runtime's own
 * project store — the CLI records a conversation when it receives one, not when it starts.
 *
 * A spawn on a read is deliberate here and stays out of the resident monitoring path, which
 * promises the opposite. This is the catalog operation a caller invokes once before creating a
 * session, and the same operation already opens an RPC connection for the other native runtime.
 */

const PROBE_DEADLINE_MS = 30_000;
/**
 * How long a probed list is reused.
 *
 * It describes an installation, not a moment, so it does not go stale in seconds; but it does go
 * stale when the operator upgrades the CLI, and nothing here is told when that happens. Minutes
 * bound that window while keeping the common case — a chooser paging through a catalog it just
 * requested — free of a second spawn.
 */
const PROBE_TTL_MS = 5 * 60_000;

interface Probed {
  models: readonly ControlModel[];
  observedAt: string;
}
/** Keyed by the resolved SDK path: a different installation is a different answer. */
const cached = new Map<string, { probed: Probed; expires: number }>();
const inFlight = new Map<string, Promise<Probed>>();

async function ask(m: MachineConfig, path: string, signal: AbortSignal): Promise<Probed> {
  const sdk = (await import(path)) as {
    query: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
  };
  if (typeof sdk.query !== 'function')
    throw new Error('the agent SDK at this path exposes no query entry point');
  // Never yields, and is never advanced by anything here: the runtime is asked what it can run and
  // is given nothing to run.
  const idle = (async function* () {
    await new Promise<never>(() => {});
  })() as AsyncIterable<SDKUserMessage>;
  const query = sdk.query({
    prompt: idle,
    options: {
      pathToClaudeCodeExecutable: m.claudeBin,
      // The host's own state directory: an existing private path that is nobody's workspace, so
      // the probe reads the operator's settings without presenting itself as work in a project.
      cwd: m.stateDir,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    } as unknown as Options,
  });
  try {
    const supported = await Promise.race([
      query.supportedModels?.() as Promise<SupportedModel[] | undefined> | undefined,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the runtime did not answer within the probe deadline')),
          PROBE_DEADLINE_MS,
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('the read was cancelled'));
          },
          { once: true },
        );
      }),
    ]);
    if (!supported || supported.length === 0) throw new Error('the runtime returned no model list');
    // No current model to mark: nothing on this host has chosen one yet, and marking a default the
    // runtime did not name would be this side inventing the answer it came here to read.
    return { models: claudeModels(supported, null), observedAt: new Date().toISOString() };
  } finally {
    query.return?.();
  }
}

/**
 * The list this host offers, probed at most once per interval and once at a time.
 *
 * Single-flight because a chooser that opens a catalog usually asks more than once, and every
 * concurrent read would otherwise start its own child.
 */
export async function probeClaudeModels(m: MachineConfig, signal: AbortSignal): Promise<Probed> {
  const resolved = resolveAgentSdk(m);
  if ('unavailable' in resolved) throw new AppError('UNSUPPORTED', resolved.detail, 409);
  const key = resolved.path;
  const hit = cached.get(key);
  if (hit && hit.expires > Date.now()) return hit.probed;
  const running = inFlight.get(key);
  if (running) return await running;
  const started = ask(m, key, signal)
    .then((probed) => {
      cached.set(key, { probed, expires: Date.now() + PROBE_TTL_MS });
      return probed;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, started);
  return await started;
}
