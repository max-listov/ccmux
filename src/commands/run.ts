import { existsSync } from 'node:fs';
import { type AgentProvider, providerFor } from '../agent/index.ts';
import { computeStamp } from '../agent/launchStamp.ts';
import { readLaunchStamp, writeLaunchStamp } from '../agent/sessionStatus.ts';
import { droppedDeadAgentKeys, withoutDeadAgentEnv } from '../agent/sshEnv.ts';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../chat/auth.ts';
import { readLifecycleBlockForSession, writeLifecycleBlock } from '../config/lifecycleBlocks.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { promptInvocation } from '../env.ts';
import { nativeDriver } from '../runtime/driver.ts';
import { ManagedRuntimeExit } from '../runtime/exit.ts';
import { capturePane, sendKeysNamed } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { log, setStderrLogging } from '../util/log.ts';

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FAST_FAIL_MS = 5_000; // exited sooner than this == suspicious
const FAST_FAILS_BEFORE_FORK = 3;

const PICKER_WATCH_MS = 45_000; // give up watching for blocking startup menus after this
const PICKER_POLL_MS = 1_000;

/**
 * Dismiss Claude's BLOCKING "Resume from summary?" picker on an unattended resume, so a
 * daemon-healed reboot doesn't strand a big session at a menu (typed input would land on the
 * menu, not the conversation). One-shot + bounded: the first time the picker is seen we send
 * the policy choice (the option NUMBER), then confirm with Enter ONLY if the number key didn't
 * already select-and-confirm (re-check avoids a stray Enter submitting an empty turn). A session
 * that never shows a picker just costs a few cheap captures until PICKER_WATCH_MS. Provider-
 * agnostic: a no-op when the provider has no picker or the policy is "off". Not awaited by the
 * supervisor — it self-terminates while the loop blocks on the agent's exit.
 */
async function settlePrompts(m: MachineConfig, s: Session, provider: AgentProvider): Promise<void> {
  const answer = provider.promptAnswer;
  if (!answer) return;
  const deadline = Date.now() + PICKER_WATCH_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(PICKER_POLL_MS);
    let key: string | null = null;
    try {
      key = answer(await capturePane(m, s.name, 40), m);
    } catch {
      continue; // pane not capturable yet (still spawning) — retry
    }
    if (key === null) continue;
    await sendKeysNamed(m, s.name, key);
    await Bun.sleep(500); // let the menu register the selection
    let stillUp = false;
    try {
      stillUp = answer(await capturePane(m, s.name, 40), m) !== null;
    } catch {
      stillUp = false;
    }
    if (stillUp) await sendKeysNamed(m, s.name, 'Enter'); // number only moved the cursor → confirm
    log.info({ msg: 'answered a blocking prompt', name: s.name, agent: provider.id, key });
    // Deliberately NOT returning: startup can raise more than one menu in a row (folder trust, then
    // the resume picker). Answering the first and walking away is how a session still ends up
    // stranded — the loop keeps watching until its own deadline.
  }
}

/**
 * The in-session conversation-level supervisor. ccmux (this loop) — NOT the agent — is
 * the tmux pane's foreground process, so an agent crash just relaunches here. Fully
 * provider-agnostic: launch argv/env, history location and resume are all decided by
 * the session's AgentProvider.
 *
 *  - P0-1: the spawn is caught INSIDE the loop, and cwd is passed to Bun.spawn (no
 *    process-global chdir). A deleted dir fails the spawn, not the supervisor.
 *  - P0-2: exponential backoff (2s→60s), never a 2s hot-loop; after K fast failures
 *    try a provider recovery (Claude `--fork-session`) once to unwedge.
 *  - P0-3: "fast failure" is judged by ELAPSED TIME, not exit code — the agent may
 *    exit 0 even on a resume error.
 */
export async function cmdRun(name: string | undefined): Promise<number> {
  if (!name) {
    log.error({ msg: '_run requires a session name' });
    return 1;
  }
  const m = loadMachineConfig();
  const initial = findSession(loadSessions(m), name);
  if (!initial) {
    log.error({ msg: 'unknown session', name });
    return 1;
  }
  // From here on this process shares a terminal with the agent it supervises: `_run` is the tmux
  // pane's FOREGROUND process and the agent inherits its stdio. A structured log line mirrored to
  // stderr therefore prints straight into the agent's UI and lands in its INPUT BUFFER — proven
  // live: a session's composer held `{"msg":"answered resume picker",…}`, which then tripped the
  // "composer occupied" delivery gate and silenced that session's chat for good, while blaming a
  // human who wasn't there. The logger already has this switch for exactly this reason; the TUI
  // uses it so Ink isn't corrupted, and `_run` needs it for the same reason. Nothing is lost —
  // every record still goes to the state root's ccmux.log.
  setStderrLogging(false);
  if (readLifecycleBlockForSession(m, initial)) return 1;
  return superviseReady(m, name, initial.agent);
}

/** Supervise only a READY registry Session. Every child launch reloads canonical identity. */
export async function superviseReady(
  m: MachineConfig,
  name: string,
  expectedAgent: Session['agent'],
): Promise<number> {
  let backoff = MIN_BACKOFF_MS;
  let fastFails = 0;
  let forkNext = false;

  for (;;) {
    const s = findSession(loadSessions(m), name);
    if (!s) return 1;
    if (s.agent !== expectedAgent) {
      await writeLifecycleBlock(m, {
        name,
        agent: expectedAgent,
        uuid: s.uuid,
        ...(s.registrationGeneration !== undefined ? { generation: s.registrationGeneration } : {}),
        error: `provider changed from ${expectedAgent} to ${s.agent} while supervisor was alive`,
        at: new Date().toISOString(),
      });
      return 1;
    }
    const provider = providerFor(s);
    const driver = nativeDriver(s);
    if (driver !== null) {
      const started = Date.now();
      try {
        await driver.run(m, s);
        return 0;
      } catch (error) {
        if (error instanceof ManagedRuntimeExit) {
          backoff =
            Date.now() - started < FAST_FAIL_MS
              ? Math.min(backoff * 2, MAX_BACKOFF_MS)
              : MIN_BACKOFF_MS;
          log.warn({
            msg: 'native provider exited; resuming pinned identity',
            name,
            backoffMs: backoff,
          });
          await Bun.sleep(backoff);
          continue;
        }
        await writeLifecycleBlock(m, {
          name,
          agent: s.agent,
          uuid: s.uuid,
          ...(s.registrationGeneration === undefined
            ? {}
            : { generation: s.registrationGeneration }),
          error: String(error),
          at: new Date().toISOString(),
        });
        return 1;
      }
    }
    const hf = provider.historyFile(s, m);
    const present = hf !== null && existsSync(hf); // re-checked every loop
    if (provider.id === 'codex' && !present) {
      const error = `ready Codex session ${name} is missing rollout ${s.uuid}`;
      await writeLifecycleBlock(m, {
        name,
        agent: s.agent,
        uuid: s.uuid,
        ...(s.registrationGeneration !== undefined ? { generation: s.registrationGeneration } : {}),
        error,
        at: new Date().toISOString(),
      });
      console.error(`ccmux: ${error}`);
      return 1;
    }
    // "No history here" means one of two very different things, and treating them alike is how a
    // month-old conversation gets a blank one written on top of it with the same uuid. A session that
    // has launched before HAS a stamp; if its history is gone anyway, something moved it — most often
    // the project directory was renamed, which changes where the agent keeps the conversation while
    // the registry still points at the old path. Measured on a live fleet: 140 MB of history sitting
    // under the previous encoding while a fresh, empty file was being written at the new one.
    // Blocking is the honest response: it is terminal, an explicit start/restart clears it, and it
    // costs a stopped session instead of an unrecoverable overwrite. Starting fresh is only correct
    // when the session has genuinely never run.
    if (!present && readLaunchStamp(name) !== null) {
      const found = provider.findHistoryElsewhere?.(s, m) ?? null;
      const where =
        found === null ? 'and it is nowhere else under the projects root' : `— it is at ${found}`;
      const error =
        `${name} has launched before, but its conversation ${s.uuid} is missing at ${hf ?? 'its expected path'} ${where}. ` +
        'Refusing to start a NEW conversation on top of it. ' +
        // Both exits, because the two cases need opposite actions and the reader knows which one
        // they are in — naming only the recoverable one leaves the other guessing.
        `If it can be recovered (the project directory moved?), put it where this session now points, then: ccmux start ${name}   ·   ` +
        `If it is gone for good: ccmux renew ${name}   — a fresh conversation for this session, keeping its dir, mode, chat and prompt modules`;
      await writeLifecycleBlock(m, {
        name,
        agent: s.agent,
        uuid: s.uuid,
        ...(s.registrationGeneration !== undefined ? { generation: s.registrationGeneration } : {}),
        error,
        at: new Date().toISOString(),
      });
      console.error(`ccmux: ${error}`);
      return 1;
    }
    let env = provider.launchEnv(m, s);
    // A session outlives the login that created it; that login's agent socket does not. A DEAD
    // socket left in the environment makes ssh wait on it instead of trying what the config points
    // at. A live one is never touched — it may be the only credential this machine has.
    const dropped = droppedDeadAgentKeys(env);
    if (dropped.length > 0) {
      env = withoutDeadAgentEnv(env);
      log.info({ msg: 'dropped a dead agent socket from the session launch', name, dropped });
    }
    env[CHAT_CREDENTIAL_ENV] = rotateChatCredential(m, s);
    // The invocation TAUGHT to the agent (bare `ccmux` shim when installed) — NOT the
    // absolute self re-exec; those are different concerns (see env.ts). Re-evaluated each
    // loop so a shim installed after boot is picked up on the next relaunch.
    const argv = provider.buildArgv(s, m, promptInvocation(), present);
    if (forkNext) {
      if (provider.id === 'claude') argv.push('--fork-session'); // wedge recovery (Claude only)
      forkNext = false;
    }
    // Stamp BEFORE spawning, with the very argv about to be used: that is what makes "does this
    // session still need a restart?" a readable fact instead of something to remember.
    writeLaunchStamp(name, computeStamp(s, m, promptInvocation()));
    const startedAt = Date.now();
    let crashed = false;
    try {
      const proc = Bun.spawn(argv, {
        cwd: s.dir,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env,
      });
      // Every launch, not just a resume. The resume picker is indeed resume-only, but the folder
      // trust dialog greets a FRESH session in a directory the agent has not seen — and gating the
      // watcher on `present` is why a fleet-wide restart once left half the sessions stranded at a
      // menu nobody was there to answer. Fire-and-forget: the watcher bounds and ends itself.
      void settlePrompts(m, s, provider);
      await proc.exited;
    } catch (e) {
      crashed = true;
      log.error({ msg: 'agent spawn failed', name, agent: provider.id, err: String(e) });
      // The one case where the pane would otherwise be blank: no agent ever started, so nothing
      // else will explain the emptiness to whoever attaches. A plain sentence, never JSON.
      console.error(`ccmux: could not start ${provider.id} — ${String(e)}`);
    }

    const elapsed = Date.now() - startedAt;
    if (crashed || elapsed < FAST_FAIL_MS) {
      fastFails += 1;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      log.warn({
        msg: 'agent exited fast',
        name,
        agent: provider.id,
        elapsedMs: elapsed,
        fastFails,
        backoffMs: backoff,
      });
      if (provider.id === 'codex') {
        let writerConflict = false;
        try {
          writerConflict = (await capturePane(m, name, 30)).includes(
            'already has an active writer',
          );
        } catch {
          writerConflict = false;
        }
        const error = writerConflict
          ? `Codex thread ${s.uuid} already has an active writer; lifecycle blocked`
          : `Codex resume exited before admission for ${name}; lifecycle blocked to prevent a retry storm or second writer`;
        await writeLifecycleBlock(m, {
          name,
          agent: s.agent,
          uuid: s.uuid,
          ...(s.registrationGeneration !== undefined
            ? { generation: s.registrationGeneration }
            : {}),
          error,
          at: new Date().toISOString(),
        });
        console.error(`ccmux: ${error}`);
        return 1;
      }
      if (fastFails >= FAST_FAILS_BEFORE_FORK) {
        forkNext = true;
        fastFails = 0;
        log.warn({ msg: 'attempting recovery relaunch', name, agent: provider.id });
      }
    } else {
      backoff = MIN_BACKOFF_MS;
      fastFails = 0;
    }
    await Bun.sleep(backoff);
  }
}
