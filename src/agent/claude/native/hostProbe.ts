import type { ExecutorProfileConfig } from 'stitchkit/agent-executor';
import { createClaudeSdkDriver } from 'stitchkit/agent-executor/claude-sdk';
import type { ClaudeProfileBinding } from '../../../config/claudeProfileSchema.ts';
import type { ControlModel } from '../../../control/schema/model.ts';
import { refusals } from '../../../control/schema/refusals.ts';
import type { MachineConfig } from '../../../types.ts';
import { claudeModels } from './catalog.ts';
import { type AgentSdk, claudeExecutorProfile } from './driver.ts';
import { resolveAgentSdk } from './resolve.ts';

const PROBE_DEADLINE_MS = 30_000;
const PROBE_TTL_MS = 5 * 60_000;

interface Probed {
  models: readonly ControlModel[];
  observedAt: string;
}

const cached = new Map<string, { probed: Probed; expires: number }>();
const inFlight = new Map<string, Promise<Probed>>();

async function ask(
  m: MachineConfig,
  path: string,
  signal: AbortSignal,
  profile: ExecutorProfileConfig,
): Promise<Probed> {
  const sdk = (await import(path)) as Partial<AgentSdk>;
  if (typeof sdk.query !== 'function')
    throw new Error('the agent SDK at this path exposes no query entry point');
  const driver = createClaudeSdkDriver({
    query: sdk.query,
    sdkVersion: 'probe',
    ...(m.claudeBin === undefined ? {} : { pathToClaudeCodeExecutable: m.claudeBin }),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
  });
  const probed = await driver.probeCapabilities({
    profile,
    cwd: m.stateDir,
    signal,
    timeoutMs: PROBE_DEADLINE_MS,
  });
  const supported = probed.models;
  if (!supported || supported.length === 0) throw new Error('the runtime returned no model list');
  return { models: claudeModels(supported, null), observedAt: new Date().toISOString() };
}

/**
 * The list this host offers, probed at most once per interval and once at a time via
 * `stitchkit/agent-executor/claude-sdk`'s `probeCapabilities`.
 */
export async function probeClaudeModels(
  m: MachineConfig,
  signal: AbortSignal,
  binding?: ClaudeProfileBinding,
): Promise<Probed> {
  const resolved = resolveAgentSdk(m);
  if ('unavailable' in resolved) throw refusals.errors.UNSUPPORTED({ message: resolved.detail });
  const profile = claudeExecutorProfile(m, {
    dir: m.stateDir,
    name: 'host-probe',
    ...(binding ? { profile: binding } : {}),
  });
  const key = JSON.stringify([
    resolved.path,
    m.claudeBin,
    profile.home,
    profile.claudeConfigDir,
    binding?.accountDigest ?? null,
  ]);
  const hit = cached.get(key);
  if (hit && hit.expires > Date.now()) return hit.probed;
  const running = inFlight.get(key);
  if (running) return await running;
  const started = ask(m, resolved.path, signal, profile)
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
