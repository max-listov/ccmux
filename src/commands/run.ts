import { existsSync } from 'node:fs';
import { type AgentProvider, providerFor } from '../agent/index.ts';
import { computeStamp } from '../agent/launch/launchStamp.ts';
import { droppedDeadAgentKeys, withoutDeadAgentEnv } from '../agent/launch/sshEnv.ts';
import {
  initialMenuSettle,
  type MenuSettleState,
  type MenuSettleStep,
} from '../agent/menuSettle.ts';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../chat/auth.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { delegationStopped } from '../delegation/cancel.ts';
import { nativeDriver } from '../runtime/driver.ts';
import { ManagedRuntimeExit } from '../runtime/exit.ts';
import { missingConversation } from '../session/conversationGuard.ts';
import {
  readLifecycleBlockForSession,
  sessionBlock,
  writeLifecycleBlock,
} from '../session/lifecycleBlocks.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { sleepBlocksStart } from '../session/sleep/store.ts';
import { writeLaunchStamp } from '../session/status.ts';
import { supervisorIsStale } from '../session/supervisorCode.ts';
import { capturePane, capturePaneScreen, sendKeysNamed } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { promptInvocation } from '../util/env.ts';
import { log, setStderrLogging } from '../util/log.ts';
import { VERSION } from '../util/version.ts';

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FAST_FAIL_MS = 5_000; // exited sooner than this == suspicious
const FAST_FAILS_BEFORE_FORK = 3;

const PICKER_WATCH_MS = 45_000; // give up watching for blocking startup menus after this
const PICKER_POLL_MS = 1_000;

/**
 * Dismiss the BLOCKING startup menus on an unattended launch, so a daemon-healed reboot or a freshly
 * created session is not stranded at a question nobody is there to answer (typed input would land on
 * the MENU, not the conversation).
 *
 * The rules for when a key may be pressed are `settleMenu` (agent/claude/menuStep.ts): a target
 * chosen by its text, one key at a time with the cursor checked to have moved one option nearer,
 * `Enter` only on a snapshot that shows the cursor on the target, and a menu answered with `Enter`
 * never answered again until the pane has been seen with no menu on it. This loop only captures the
 * visible screen, presses what the rule authorised and waits for it to render.
 *
 * ## Why the dangerous direction is the one guarded
 *
 * Missing a menu is visible: a stranded session shows in `list` and `doctor`, and a person can
 * answer it. Pressing a key into a pane that is no longer a menu is not, because there is no such
 * thing as a harmless keystroke sent to a live conversation. Without the Enter it leaves a character
 * in the composer, and an occupied composer holds every message addressed to that session, silently,
 * until somebody clears it. With the Enter it submits a turn nobody wrote. An earlier loop re-answered
 * every poll for its whole window and recorded 86 presses, all the same key, up to eight into one
 * session about 1.5 seconds apart; five composers were later found holding that character. A later
 * one pressed a final Enter whenever "a menu" was still up after its key, which on a menu with the
 * cursor on "No, exit" is a refusal.
 *
 * A step the rule stops on ends the watch rather than guessing again: the supervisor has done what it
 * can say is right.
 *
 * Provider-agnostic: a no-op when the provider has no such menu or the policy is "off". Not awaited
 * by the supervisor — it self-terminates while the loop blocks on the agent's exit.
 */
export async function settlePrompts(
  m: MachineConfig,
  s: Session,
  provider: AgentProvider,
  gone: AbortSignal,
): Promise<void> {
  const settle = provider.settleMenu;
  if (!settle) return;
  const deadline = Date.now() + PICKER_WATCH_MS;
  let state: MenuSettleState = initialMenuSettle;
  while (Date.now() < deadline) {
    await Bun.sleep(PICKER_POLL_MS);
    // The agent this watcher was answering for has exited: its menus are not this loop's to answer,
    // and a watcher left running would press keys at the NEXT launch beside that launch's own.
    if (gone.aborted) return;
    let step: MenuSettleStep;
    try {
      step = settle(state, await capturePaneScreen(m, s.name), m);
    } catch {
      continue; // pane not capturable yet (still spawning) — retry
    }
    state = step.state;
    if (step.action.act === 'wait') continue;
    if (step.action.act === 'stop') {
      log.warn({
        msg: 'stopped answering a blocking prompt',
        name: s.name,
        agent: provider.id,
        reason: step.action.reason,
      });
      return;
    }
    if (gone.aborted) return; // the agent exited while the screen was being read
    await sendKeysNamed(m, s.name, step.action.key);
    log.info({
      msg: 'answered a blocking prompt',
      name: s.name,
      agent: provider.id,
      key: step.action.key,
    });
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
/**
 * What actually went wrong, when the spawn error names the wrong thing.
 *
 * `posix_spawn` reports a missing WORKING DIRECTORY as ENOENT naming the EXECUTABLE, so the failure
 * arrives blaming a binary that is present and runnable. Chasing that costs real time: the symlink,
 * its target, the ELF header and a manual run all check out, because none of them is what is
 * missing. Measured on a live session whose registered directory had been deleted — four probes
 * before the right question got asked.
 *
 * Only ENOENT is reinterpreted, and only when the directory is genuinely absent. Any other failure
 * keeps its own text: a message that confidently explains the wrong cause is worse than one that
 * merely repeats what the system said.
 */
export function spawnFailureReason(
  error: unknown,
  name: string,
  dir: string,
  dirExists: boolean,
): string {
  if (!String(error).includes('ENOENT') || dirExists) return String(error);
  return `its working directory does not exist: ${dir} — set one that does with \`ccmux dir ${name} <path>\``;
}

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

/** Stop for good. The block is what keeps the daemon from starting the session again until an
 *  explicit start or restart clears it; the line says why to whoever attaches to the pane. */
async function refuse(m: MachineConfig, s: Session, error: string): Promise<number> {
  await writeLifecycleBlock(m, sessionBlock(s, error));
  console.error(`ccmux: ${error}`);
  return 1;
}

/** Leave the session to the daemon's heal, which starts it under the code installed now. */
function handOver(name: string): number {
  log.info({
    msg: 'supervisor: ccmux was updated since this process started — handing the session to heal',
    name,
    loadedVersion: VERSION,
  });
  return 0;
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
    // Before any decision about this session: the rules below belong to the version installed NOW. A
    // supervisor that outlived an update would judge by the old ones, and a refusal it writes is
    // final. No agent is running here, so no conversation is lost by leaving; the daemon takes the
    // session down whole (other windows of it close) and starts it again under the installed code on
    // its next heal pass (`ensureInterval`, 30 s by default).
    if (supervisorIsStale()) return handOver(name);
    if (delegationStopped(m, s) || sleepBlocksStart(m, s)) return 0;
    if (s.agent !== expectedAgent) {
      await writeLifecycleBlock(
        m,
        sessionBlock(
          s,
          `provider changed from ${expectedAgent} to ${s.agent} while supervisor was alive`,
          expectedAgent,
        ),
      );
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
        await writeLifecycleBlock(m, sessionBlock(s, String(error)));
        return 1;
      }
    }
    const hf = provider.historyFile(s, m);
    const present = hf !== null && existsSync(hf); // re-checked every loop
    if (provider.id === 'codex' && !present) {
      const error = `ready Codex session ${name} is missing rollout ${s.uuid}`;
      return refuse(m, s, error);
    }
    // "No history here" means one of two very different things, and treating them alike is how a
    // month-old conversation gets a blank one written on top of it with the same uuid. A
    // conversation this supervisor has SEEN is real: if its file is gone anyway, something moved or
    // removed it — most often the project directory was renamed, or the session's profile changed,
    // which changes where the agent keeps the conversation while the registry still points at the
    // old place. Measured on a live fleet: 140 MB of history sitting under the previous encoding
    // while a fresh, empty file was being written at the new one. Blocking is the honest response:
    // it is terminal, an explicit start/restart clears it, and it costs a stopped session instead of
    // an unrecoverable overwrite.
    // A session that merely LAUNCHED is not evidence of a conversation — the agent creates the file
    // with the first message, and one closed on its folder-trust question never had one. So the
    // guard asks what was seen, and the launch stamp (written before the agent starts, erased by
    // every stop) is not consulted. A conversation found under another root is evidence by itself.
    const refusal = missingConversation(m, s, provider, present, hf);
    if (refusal !== null) return refuse(m, s, refusal);
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
    const agentGone = new AbortController();
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
      void settlePrompts(m, s, provider, agentGone.signal);
      await proc.exited;
    } catch (e) {
      crashed = true;
      const reason = spawnFailureReason(e, name, s.dir, existsSync(s.dir));
      log.error({ msg: 'agent spawn failed', name, agent: provider.id, err: reason });
      // The one case where the pane would otherwise be blank: no agent ever started, so nothing
      // else will explain the emptiness to whoever attaches. A plain sentence, never JSON.
      console.error(`ccmux: could not start ${provider.id} — ${reason}`);
    } finally {
      agentGone.abort();
    }

    // An exit judged by the code of an older version is not judged at all: the daemon starts the
    // session again under the installed one.
    if (supervisorIsStale()) return handOver(name);
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
        return refuse(m, s, error);
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
