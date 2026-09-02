#!/usr/bin/env bun
import { COMMANDS, cmdHelp } from './commands/help.ts';
import { retiredNotice } from './commands/retired.ts';
import { VERSION } from './util/version.ts';

/**
 * Every command is loaded at its case, not at the top of this file.
 *
 * The bundle is one file and is parsed whole either way; what a static import adds is EVALUATION —
 * the whole product's module graph runs before the verb is even read. That is paid by the two hooks
 * and the status-line tee, which Claude runs on every turn and on every transcript event: measured
 * at 208 ms of CPU to do about a millisecond of work, against 43 ms for the same work with nothing
 * else evaluated. Seventeen sessions on one machine turn that into a constant background load.
 *
 * So the rule is the whole dispatch, not an exception for the heavy ones. An exception invites the
 * question "is this one heavy enough", and the honest answer is that nobody knows: `list` reaches
 * the registry, `msg` reaches the chat ledger, and either can grow a dependency next week without
 * anyone noticing it landed on the hook path. The TUI was already lazy for exactly this reason.
 */
async function launchTui(fullscreen: boolean): Promise<number> {
  const { runTui } = await import('./tui/run.tsx');
  return runTui(fullscreen);
}

/** positionals before a literal `--`, everything after it is passthrough flags. */
function splitDashDash(rest: string[]): { positionals: string[]; flags: string[] } {
  const i = rest.indexOf('--');
  if (i === -1) return { positionals: rest, flags: [] };
  return { positionals: rest.slice(0, i), flags: rest.slice(i + 1) };
}

/** first non-flag positional + whether --force/-f is present (stop/rm self-guard). */
function nameForce(rest: string[]): { name: string | undefined; force: boolean } {
  const force = rest.includes('--force') || rest.includes('-f');
  const name = rest.find((a) => a !== '--force' && a !== '-f');
  return { name, force };
}

/** Every public verb supports `<verb> --help` — derived from COMMANDS so the two
 *  lists can't drift (they did: transcript/doctor were help-routed but unlisted). */
const HELP_VERBS = new Set(['remove', ...COMMANDS.map((c) => c.verb)]);

async function dispatch(verb: string | undefined, rest: string[]): Promise<number> {
  // `ccmux <cmd> --help` → help for that command (before the command parses args).
  if (
    verb !== undefined &&
    verb !== 'control' &&
    HELP_VERBS.has(verb) &&
    (rest.includes('--help') || rest.includes('-h'))
  ) {
    return cmdHelp(verb === 'remove' ? 'rm' : verb);
  }
  // Before any command parses: a token we RETIRED gets its replacement, not a generic usage line.
  // Here rather than in each command, so a new verb cannot forget it (see commands/retired.ts).
  const retired = retiredNotice(verb, rest);
  if (retired !== null) {
    console.log(retired);
    return 1;
  }
  switch (verb) {
    case 'control':
      return (await import('./commands/control.ts')).cmdControl(rest);
    case 'runtime':
      return (await import('./commands/runtime.ts')).cmdRuntime(rest[0], rest.slice(1));
    case 'status':
      return (await import('./commands/status.ts')).cmdStatus(rest);
    case 'list':
    case 'ls':
    case 'l':
      return (await import('./commands/list.ts')).cmdList(rest);
    case 'new': {
      const { positionals, flags } = splitDashDash(rest);
      const router = positionals.includes('--router');
      const agentIndex = positionals.indexOf('--agent');
      const agent = agentIndex >= 0 ? (positionals[agentIndex + 1] ?? '') : undefined;
      const envIndex = positionals.indexOf('--env-file');
      const envFile = envIndex >= 0 ? positionals[envIndex + 1] : undefined;
      const runtimeIndex = positionals.indexOf('--runtime');
      const runtime = runtimeIndex >= 0 ? (positionals[runtimeIndex + 1] ?? '') : undefined;
      const consumed = new Set<number>();
      if (agentIndex >= 0) consumed.add(agentIndex).add(agentIndex + 1);
      if (envIndex >= 0) consumed.add(envIndex).add(envIndex + 1);
      if (runtimeIndex >= 0) consumed.add(runtimeIndex).add(runtimeIndex + 1);
      const pos = positionals.filter((a, index) => a !== '--router' && !consumed.has(index));
      return (await import('./commands/new.ts')).cmdNew(pos[0], pos[1], flags, {
        router,
        ...(agent === undefined ? {} : { agent }),
        ...(envFile === undefined ? {} : { envFile }),
        ...(runtime === undefined ? {} : { runtime }),
      });
    }
    case 'rm':
    case 'remove': {
      const { name, force } = nameForce(rest);
      return (await import('./commands/rm.ts')).cmdRm(name, force);
    }
    case 'start':
      return (await import('./commands/lifecycle.ts')).cmdStart(rest[0]);
    case 'stop': {
      const { name, force } = nameForce(rest);
      return (await import('./commands/lifecycle.ts')).cmdStop(name, force);
    }
    case 'restart':
      return rest.includes('--all')
        ? (await import('./commands/restartAll.ts')).cmdRestartAll(rest)
        : (await import('./commands/lifecycle.ts')).cmdRestart(rest);
    case 'renew':
      return (await import('./commands/renew.ts')).cmdRenew(rest[0], rest.slice(1));
    case 'mode':
      return (await import('./commands/mode.ts')).cmdMode(rest[0], rest[1]);
    case 'env-file':
      return (await import('./commands/envFile.ts')).cmdEnvFile(rest);
    case 'dir':
      return (await import('./commands/dir.ts')).cmdDir(rest);
    case 'role':
      return (await import('./commands/role.ts')).cmdRole(rest);
    case 'relay':
      return (await import('./commands/relay.ts')).cmdRelay(rest);
    case 'events':
      return (await import('./commands/events.ts')).cmdEvents(rest);
    case 'send':
      return (await import('./commands/send.ts')).cmdSend(rest[0], rest.slice(1));
    case 'msg':
      return (await import('./commands/msg.ts')).cmdMsg(rest);
    case '_chat-receive-v2':
      return (await import('./commands/msg.ts')).cmdReceiveChat();
    case '_codex-app-resolve':
      return (await import('./commands/msg.ts')).cmdResolveCodexApp(rest);
    case 'inbox':
      return (await import('./commands/inbox.ts')).cmdInbox(rest);
    case 'chat':
      return (await import('./commands/chat.ts')).cmdChat(rest);
    case 'router':
      return (await import('./commands/router.ts')).cmdRouter(rest);
    case 'logs':
      return (await import('./commands/logs.ts')).cmdLogs(rest[0], rest.slice(1));
    case 'transcript':
      return (await import('./commands/transcript.ts')).cmdTranscript(rest[0], rest.slice(1));
    case 'wait':
      return (await import('./commands/wait.ts')).cmdWait(rest[0], rest.slice(1));
    case 'models':
      return (await import('./commands/models.ts')).cmdModels(rest);
    case 'doctor':
      return (await import('./commands/doctor.ts')).cmdDoctor(rest);
    case 'fleet':
      return (await import('./commands/fleetList.ts')).cmdFleet(rest);
    case 'external':
      return (await import('./commands/external.ts')).cmdExternal(rest);
    case 'completions':
      return (await import('./commands/completions.ts')).cmdCompletions(rest);
    case 'ensure':
      return (await import('./commands/ensure.ts')).cmdEnsure();
    case 'update':
      return (await import('./commands/update.ts')).cmdUpdate(rest);
    case 'adopt':
      return (await import('./commands/adopt.ts')).cmdAdopt(rest);
    case 'install':
      return (await import('./commands/install.ts')).cmdInstall(rest);
    case 'uninstall':
      return (await import('./commands/install.ts')).cmdUninstall();
    case 'daemon':
      return (await import('./commands/daemon.ts')).cmdDaemon(); // never returns
    case '_attachment-validate':
      return (await import('./attachments/decoderCommand.ts')).cmdValidateAttachment();
    case '_run':
      return (await import('./commands/run.ts')).cmdRun(rest[0]); // hidden: in-session relaunch loop (tmux invokes this)
    case '_bootstrap':
      return (await import('./commands/bootstrap.ts')).cmdBootstrap(rest[0]); // hidden: pending Codex first-launch transaction
    case '_restart-worker':
      return (await import('./commands/lifecycle.ts')).cmdRestartWorker(rest[0]); // hidden: detached restart helper
    case '_restart-all-worker':
      return (await import('./commands/restartAll.ts')).cmdRestartAllWorker(); // hidden: detached fleet-sweep driver (restart --all)
    case 'stop-hook':
      return (await import('./commands/stopHook.ts')).cmdStopHook(); // hidden: Claude Stop-hook — injects deferred chat mail at end-of-turn
    case 'hook-status':
      return (await import('./commands/hookStatus.ts')).cmdHookStatus(); // hidden: Claude lifecycle hooks → working/idle status file
    case 'status-line':
      return (await import('./commands/statusLine.ts')).cmdStatusLine(); // hidden: Claude statusLine tee → context% metrics + render original
    case 'control-native-stream':
      return (await import('./commands/controlNativeStream.ts')).cmdControlNativeStream();
    case 'version':
    case '-v':
    case '--version':
      console.log(`ccmux ${VERSION}`);
      return 0;
    case 'help':
    case '-h':
    case '--help':
      return cmdHelp(rest[0]);
    case 'tui':
      return launchTui(rest.includes('-f') || rest.includes('--fullscreen'));
    case '-f':
    case '--fullscreen':
      return launchTui(true);
    case undefined:
      // bare `ccmux` → interactive TUI on a real terminal; piped/non-TTY → help.
      return process.stdout.isTTY ? launchTui(false) : cmdHelp();
    default:
      cmdHelp();
      return 1; // unknown verb → help, nonzero
  }
}

// Let Bun drain stdout/stderr before exiting. `process.exit()` can discard a large JSON response
// while a pipeline is still reading it; assigning the code preserves command failures without
// terminating the event loop ahead of its pending writes.
process.exitCode = await dispatch(Bun.argv[2], Bun.argv.slice(3));
