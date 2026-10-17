import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { providerFor } from '../agent/index.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { createManagedSession } from '../session/create.ts';
import { readLifecycleBlockForSession } from '../session/lifecycleBlocks.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { capturePaneScreen } from '../tmux/tmux.ts';
import { log } from '../util/log.ts';
import { cmdWait } from './wait.ts';

/** How long an interactive Claude session may take to be ready for messages, folder-trust question
 *  included. Longer than the supervisor's own watch for startup menus. */
const READY_TIMEOUT_SEC = 60;

/**
 * Register a new managed session and start it. Flags after `--` are stored verbatim
 * as an array (e.g. `ccmux new cc-x /dir -- --model claude-opus-4-8[1m]`).
 */
export async function cmdNew(
  name: string | undefined,
  dir: string | undefined,
  flags: string[],
  opts: {
    router?: boolean;
    agent?: string;
    envFile?: string;
    runtime?: string;
    timeoutSec?: number;
  } = {},
): Promise<number> {
  if (!name || !dir) {
    console.log(
      'usage: ccmux new <name> <dir> [--agent claude|codex|opencode] [--runtime tui|app-server|native] [--router] [--env-file <path>] [--timeout N] [-- provider flags...]',
    );
    return 1;
  }
  if (name.includes('|')) {
    console.log("name cannot contain '|'");
    return 1;
  }
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    console.log(`dir not found: ${abs}`);
    return 1;
  }
  const m = loadMachineConfig();
  try {
    // --router: this session carries the router protocol module and, since it drives ccmux chat,
    // has chat enabled. Just DATA (a module key + a bool), resolved to live code at launch.
    const router = opts.router === true;
    const agent = AgentKindSchema.parse(opts.agent ?? 'claude');
    const session = await createManagedSession(m, {
      name,
      dir: abs,
      agent,
      flags,
      router,
      ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
      ...(opts.envFile === undefined ? {} : { envFile: opts.envFile }),
    });
    log.info({ msg: 'session registered', name, dir: abs, uuid: session.uuid });
    console.log(`added: ${JSON.stringify(session)}`);
    // Registered and started is not ready: a fresh interactive Claude asks whether it may trust the
    // folder before it can take a message. The creator asked for a session to work with, so the
    // command returns when that is true — and says why when it is not, rather than leaving a
    // question nobody is looking at.
    if (agent === 'claude' && !hasNativeRuntime(session))
      return await untilReady(m, name, opts.timeoutSec ?? READY_TIMEOUT_SEC);
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return 0;
}

/** Wait for the new session to be between turns; exit 2 with the reason when it is not in time. */
async function untilReady(
  m: ReturnType<typeof loadMachineConfig>,
  name: string,
  timeoutSec: number,
): Promise<number> {
  const code = await cmdWait([name, '--timeout', String(timeoutSec)]);
  if (code === 0) return 0;
  // `wait` has already said what it saw — which menu the session is at, or that it is not running.
  // 1 is an answer it gave at once; only 2 means the time ran out.
  const session = findSession(loadSessions(m), name);
  // The question the session is stuck on, when it is stuck on one: a person reading this needs the
  // question, not only the fact that time ran out.
  if (session !== undefined) {
    const screen = await capturePaneScreen(m, name).catch(() => '');
    const waitingOn = providerFor(session).scanPane(screen).atPrompt;
    if (waitingOn !== null) console.error(`${name} is waiting on: ${waitingOn}`);
  }
  const block = session === undefined ? null : readLifecycleBlockForSession(m, session);
  console.error(
    block === null
      ? code === 2
        ? `${name} is registered but was not ready within ${timeoutSec}s — see \`ccmux list\` for what it is waiting on`
        : `${name} is registered but not running — see \`ccmux list\``
      : `${name} is registered but blocked: ${block.error}`,
  );
  return 2;
}
