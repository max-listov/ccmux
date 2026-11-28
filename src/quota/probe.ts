import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { antigravityCanProbeUsage, antigravityFileAccount } from '../agent/antigravity/account.ts';
import { cachedAntigravityTier } from '../agent/antigravity/catalog.ts';
import { antigravityProfileId } from '../agent/antigravity/namedProfiles.ts';
import {
  antigravityBin,
  antigravityDataDir,
  antigravityDirFlags,
} from '../agent/antigravity/preflight.ts';
import { CLAUDE_PROFILE_AUTH_ENV } from '../agent/claude/profileRoot.ts';
import { isReservedEnvKey, readEnvFile } from '../agent/launch/sessionEnv.ts';
import { STATE_DIR } from '../config/paths.ts';
import { codexPlanLimits } from '../runtime/planLimits.ts';
import type { PlanLimits } from '../runtime/planLimitsSchema.ts';
import type { MachineConfig } from '../types.ts';
import { run } from '../util/spawn.ts';
import { parseAntigravityLogIdentity, parseAntigravityUsage } from './antigravityUsage.ts';
import { parseClaudeUsage, usageLimits } from './claudeUsage.ts';
import type { QuotaProvider } from './store.ts';

/**
 * One account's quota, asked of the vendor's own command-line program.
 *
 * No token is read or sent by stitchmux: the program authenticates itself, which is the point of asking
 * it. Both programs are asked about a PROFILE — a Claude config directory or a Codex home — and
 * answer for whoever is signed in there, so an account with no running session is as visible as one
 * with ten. The answer carries `source: 'probe'`; it is a measurement of the moment it was taken,
 * and the caller decides whether a fresher one from a status line is better.
 */

export interface ProbeTarget {
  provider: QuotaProvider;
  /** `claude:<config dir>` / `codex:<home>` / `antigravity:<dataDir>`; `default` for the default profile. */
  key: string;
  /** The profile's directory, or null for the default one. */
  home: string | null;
  /** A session's declared env file for this profile: the program must run in the environment the
   *  sessions do (an empty API key variable switches key billing off there). */
  envFile: string | null;
}

export type ProbeOutcome =
  | {
      ok: true;
      label: string | null;
      plan: string | null;
      /** The vendor's own name for how the account is served (`firstParty`, `chatgpt`). */
      provider: string | null;
      limits: PlanLimits;
    }
  | { ok: false; error: string };

/**
 * Variables the child must not inherit: the ones that name a profile (the target sets its own), mark
 * the caller as another Claude, or carry any credential. The probe asks about the PROFILE's own
 * login, so a token, key, cloud switch or gateway in the daemon's or a shell's environment would
 * answer for a different account — the launch of a session removes the same names for the same
 * reason. What the profile's declared env file then sets is applied on top, as it is for a session.
 */
const STRIPPED = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'AGY_CLI_FORCE_FILE_TOKEN_STORAGE',
  ...CLAUDE_PROFILE_AUTH_ENV,
];

function childEnv(target: ProbeTarget): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !STRIPPED.includes(key) && !isReservedEnvKey(key)) env[key] = value;
  if (target.envFile !== null) {
    for (const [key, value] of Object.entries(readEnvFile(target.envFile, env)))
      if (!isReservedEnvKey(key)) env[key] = value;
  }
  if (target.home !== null) {
    if (target.provider === 'claude') env.CLAUDE_CONFIG_DIR = target.home;
    else if (target.provider === 'codex') env.CODEX_HOME = target.home;
    else if (target.provider === 'antigravity') env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = '1';
  }
  return env;
}

/** A value a vendor program returned, trimmed and bounded; empty is absent. The store refuses an
 *  empty string, and one odd answer must not abort a pass over every other profile. */
const clean = (value: string | null | undefined, max: number): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text.slice(0, max);
};

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().nullish(),
  apiProvider: z.string().nullish(),
  email: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});

/** A scratch directory the probe runs in, so the program never writes a project entry for anything
 *  the user works in. Created once and reused. */
function probeDirectory(): string {
  const dir = `${STATE_DIR}/quota/probe-cwd`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PROBE_TIMEOUT_MS = 90_000;

type AuthResult =
  | { ok: true; status: z.infer<typeof AuthStatusSchema> }
  | { ok: false; error: string };

async function claudeAuthStatus(
  bin: string,
  env: Record<string, string>,
  cwd: string,
  signal?: AbortSignal,
): Promise<AuthResult> {
  const auth = await run([bin, 'auth', 'status', '--json'], {
    cwd,
    env,
    timeoutMs: 15_000,
    signal,
  });
  if (auth.timedOut) return { ok: false, error: 'claude auth status timed out' };
  try {
    const status = AuthStatusSchema.parse(JSON.parse(auth.stdout));
    if (auth.code !== 0 && (status.loggedIn || auth.code !== 1))
      return { ok: false, error: `claude auth status exited ${auth.code}` };
    return { ok: true, status };
  } catch {
    return { ok: false, error: 'claude auth status gave no readable answer' };
  }
}

/** Reads the vendor's login status without making an inference or asking about usage. */
export function profileAuthStatus(m: MachineConfig, home: string | null): Promise<AuthResult> {
  const env = childEnv({ provider: 'claude', key: home ?? 'default', home, envFile: null });
  return claudeAuthStatus(m.claudeBin, env, probeDirectory());
}

export async function probeClaude(
  m: MachineConfig,
  target: ProbeTarget,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const env = childEnv(target);
  const cwd = probeDirectory();
  const auth = await claudeAuthStatus(m.claudeBin, env, cwd, signal);
  if (!auth.ok) return auth;
  const { status } = auth;
  if (!status.loggedIn) return { ok: false, error: 'the profile is not signed in' };
  const now = Date.now();
  const label = clean(status.email, 256);
  const plan = clean(status.subscriptionType, 64);
  const provider = clean(status.apiProvider, 64);
  // Only a claude.ai login has plan windows. Anything else — an API key, a cloud provider, a
  // gateway — is billed by the token, and is decided HERE from who is signed in, not from how
  // `/usage` words its answer.
  if (
    (status.authMethod ?? 'claude.ai') !== 'claude.ai' ||
    (provider ?? 'firstParty') !== 'firstParty'
  )
    return {
      ok: true,
      label,
      plan,
      provider,
      limits: usageLimits({ kind: 'no-plan-limit' }, plan, now),
    };
  // No MCP servers and no hooks: the program would otherwise start the profile's whole tool chain to
  // answer a local command (the main profile's cost drops by a quarter). A cheap model, because if a
  // build ever stops handling `/usage` itself the text goes to the model as a prompt, and that must
  // cost one small reply, not one of the account's large ones.
  const usage = await run(
    [
      m.claudeBin,
      '-p',
      '/usage',
      '--no-session-persistence',
      '--model',
      'haiku',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      '{"disableAllHooks":true}',
    ],
    { cwd, env, timeoutMs: PROBE_TIMEOUT_MS, signal },
  );
  if (usage.timedOut) return { ok: false, error: 'claude /usage timed out' };
  if (usage.code !== 0) return { ok: false, error: `claude /usage exited ${usage.code}` };
  const parsed = parseClaudeUsage(usage.stdout, Date.now());
  if (parsed.kind === 'unrecognised')
    return { ok: false, error: `unrecognised /usage output: ${parsed.line}` };
  return { ok: true, label, plan, provider, limits: usageLimits(parsed, plan, Date.now()) };
}

/** A line-delimited JSON-RPC conversation with `codex app-server`, closed on every path. */
async function codexRpc(
  bin: string,
  env: Record<string, string>,
  calls: { method: string; params?: unknown }[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const proc = Bun.spawn([bin, 'app-server'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const results: unknown[] = [];
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const abort = (): void => void proc.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (id: number): Promise<unknown> => {
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
            if (message.id === id) {
              if (message.error !== undefined) throw new Error('the server refused the request');
              return message.result;
            }
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('the server')) throw error;
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('the server closed before answering');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'stitchmux-quota', version: '0' }, capabilities: {} },
    });
    await next(1);
    send({ method: 'initialized' });
    let id = 2;
    for (const call of calls) {
      send({
        id,
        method: call.method,
        ...(call.params === undefined ? {} : { params: call.params }),
      });
      results.push(await next(id));
      id += 1;
    }
    return results;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    proc.kill();
  }
}

const CodexAccountSchema = z.object({
  account: z
    .object({
      type: z.string().optional(),
      planType: z.string().optional(),
      email: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export async function probeCodex(
  m: MachineConfig,
  target: ProbeTarget,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  if (m.codexBin === undefined) return { ok: false, error: 'no codex executable is configured' };
  let account: z.infer<typeof CodexAccountSchema>;
  let limitsRaw: unknown;
  try {
    const [accountRaw, rateRaw] = await codexRpc(
      m.codexBin,
      childEnv(target),
      [
        { method: 'account/read', params: { refreshToken: false } },
        { method: 'account/rateLimits/read' },
      ],
      30_000,
      signal,
    );
    account = CodexAccountSchema.parse(accountRaw);
    limitsRaw = rateRaw;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 160) : 'codex probe failed',
    };
  }
  const info = account.account;
  if (info === null || info === undefined)
    return { ok: false, error: 'the Codex home is not signed in' };
  const now = Date.now();
  const label = clean(info.email, 256);
  const plan = clean(info.planType, 64);
  if (info.type === 'apiKey')
    return {
      ok: true,
      label,
      plan,
      provider: clean(info.type, 64),
      limits: {
        answer: 'no-plan-limit',
        plan,
        windows: [],
        observedAt: new Date(now).toISOString(),
        source: 'probe',
        error: null,
      },
    };
  const limits = codexPlanLimits(limitsRaw, now, 'probe');
  return {
    ok: true,
    label,
    plan: limits.plan ?? plan,
    provider: clean(info.type, 64),
    limits,
  };
}

export async function probeAntigravity(
  m: MachineConfig,
  target: ProbeTarget,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const executable = antigravityBin(m);
  if (executable === undefined)
    return { ok: false, error: 'no antigravity executable is configured' };
  const dataDir = target.home ?? antigravityDataDir(m);
  const forceFileStorage = target.home !== null;
  const gate = await antigravityCanProbeUsage(dataDir, { forceFileStorage });
  if (!gate.ok) return { ok: false, error: gate.reason };

  const env = childEnv(target);
  const logDir = mkdtempSync(join(tmpdir(), 'stitchmux-agy-usage-'));
  const logFile = join(logDir, 'usage.log');
  try {
    const argv = [
      executable,
      ...antigravityDirFlags(dataDir),
      '-p',
      '/usage',
      '--output-format',
      'json',
      '--log-file',
      logFile,
    ];
    const usage = await run(argv, {
      cwd: probeDirectory(),
      env,
      timeoutMs: 30_000,
      signal,
    });
    if (usage.timedOut) return { ok: false, error: 'agy /usage timed out' };
    if (usage.code !== 0) return { ok: false, error: `agy /usage exited ${usage.code}` };
    const parsed = parseAntigravityUsage(usage.stdout, Date.now());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    let label = clean(antigravityFileAccount(dataDir)?.label, 256);
    if (label === null && existsSync(logFile)) {
      try {
        label = clean(parseAntigravityLogIdentity(readFileSync(logFile, 'utf8')).email, 256);
      } catch {
        label = null;
      }
    }
    const profileId =
      target.home === null
        ? 'default'
        : antigravityProfileId({
            agent: 'antigravity',
            source: 'machine',
            name: 'named',
            dataDir: target.home,
            storage: 'file',
          });
    const plan = clean(cachedAntigravityTier(m, profileId), 64);
    const limits = plan === null ? parsed.limits : { ...parsed.limits, plan };
    return {
      ok: true,
      label,
      plan,
      provider: 'antigravity',
      limits,
    };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

export async function probe(
  m: MachineConfig,
  target: ProbeTarget,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  try {
    if (target.provider === 'claude') return await probeClaude(m, target, signal);
    if (target.provider === 'codex') return await probeCodex(m, target, signal);
    return await probeAntigravity(m, target, signal);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 160) : 'probe failed',
    };
  }
}
