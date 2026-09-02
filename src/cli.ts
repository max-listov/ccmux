#!/usr/bin/env bun
import { cmdValidateAttachment } from './attachments/decoderCommand.ts';
import { cmdAdopt } from './commands/adopt.ts';
import { cmdBootstrap } from './commands/bootstrap.ts';
import { cmdChat } from './commands/chat.ts';
import { cmdCompletions } from './commands/completions.ts';
import { cmdControl } from './commands/control.ts';
import { cmdControlNativeStream } from './commands/controlNativeStream.ts';
import { cmdDaemon } from './commands/daemon.ts';
import { cmdDir } from './commands/dir.ts';
import { cmdDoctor } from './commands/doctor.ts';
import { cmdEnsure } from './commands/ensure.ts';
import { cmdEnvFile } from './commands/envFile.ts';
import { cmdEvents } from './commands/events.ts';
import { cmdExternal } from './commands/external.ts';
import { cmdFleet } from './commands/fleetList.ts';
import { COMMANDS, cmdHelp } from './commands/help.ts';
import { cmdHookStatus } from './commands/hookStatus.ts';
import { cmdInbox } from './commands/inbox.ts';
import { cmdInstall, cmdUninstall } from './commands/install.ts';
import { cmdRestart, cmdRestartWorker, cmdStart, cmdStop } from './commands/lifecycle.ts';
import { cmdList } from './commands/list.ts';
import { cmdLogs } from './commands/logs.ts';
import { cmdMode } from './commands/mode.ts';
import { cmdModels } from './commands/models.ts';
import { cmdMsg, cmdReceiveChat, cmdResolveCodexApp } from './commands/msg.ts';
import { cmdNew } from './commands/new.ts';
import { cmdRelay } from './commands/relay.ts';
import { cmdRenew } from './commands/renew.ts';
import { cmdRestartAll, cmdRestartAllWorker } from './commands/restartAll.ts';
import { retiredNotice } from './commands/retired.ts';
import { cmdRm } from './commands/rm.ts';
import { cmdRole } from './commands/role.ts';
import { cmdRouter } from './commands/router.ts';
import { cmdRun } from './commands/run.ts';
import { cmdRuntime } from './commands/runtime.ts';
import { cmdSend } from './commands/send.ts';
import { cmdStatus } from './commands/status.ts';
import { cmdStatusLine } from './commands/statusLine.ts';
import { cmdStopHook } from './commands/stopHook.ts';
import { cmdTranscript } from './commands/transcript.ts';
import { cmdUpdate } from './commands/update.ts';
import { cmdWait } from './commands/wait.ts';
import { VERSION } from './util/version.ts';

/** Lazy-load the TUI (ink/react) only when actually launching it — keeps every plain
 *  CLI command (list/transcript/daemon/…) free of the React runtime on startup. */
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
      return cmdControl(rest);
    case 'runtime':
      return cmdRuntime(rest[0], rest.slice(1));
    case 'status':
      return cmdStatus(rest);
    case 'list':
    case 'ls':
    case 'l':
      return cmdList(rest);
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
      return cmdNew(pos[0], pos[1], flags, {
        router,
        ...(agent === undefined ? {} : { agent }),
        ...(envFile === undefined ? {} : { envFile }),
        ...(runtime === undefined ? {} : { runtime }),
      });
    }
    case 'rm':
    case 'remove': {
      const { name, force } = nameForce(rest);
      return cmdRm(name, force);
    }
    case 'start':
      return cmdStart(rest[0]);
    case 'stop': {
      const { name, force } = nameForce(rest);
      return cmdStop(name, force);
    }
    case 'restart':
      return rest.includes('--all') ? cmdRestartAll(rest) : cmdRestart(rest);
    case 'renew':
      return cmdRenew(rest[0], rest.slice(1));
    case 'mode':
      return cmdMode(rest[0], rest[1]);
    case 'env-file':
      return cmdEnvFile(rest);
    case 'dir':
      return cmdDir(rest);
    case 'role':
      return cmdRole(rest);
    case 'relay':
      return cmdRelay(rest);
    case 'events':
      return cmdEvents(rest);
    case 'send':
      return cmdSend(rest[0], rest.slice(1));
    case 'msg':
      return cmdMsg(rest);
    case '_chat-receive-v2':
      return cmdReceiveChat();
    case '_codex-app-resolve':
      return cmdResolveCodexApp(rest);
    case 'inbox':
      return cmdInbox(rest);
    case 'chat':
      return cmdChat(rest);
    case 'router':
      return cmdRouter(rest);
    case 'logs':
      return cmdLogs(rest[0], rest.slice(1));
    case 'transcript':
      return cmdTranscript(rest[0], rest.slice(1));
    case 'wait':
      return cmdWait(rest[0], rest.slice(1));
    case 'models':
      return cmdModels(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'fleet':
      return cmdFleet(rest);
    case 'external':
      return cmdExternal(rest);
    case 'completions':
      return cmdCompletions(rest);
    case 'ensure':
      return cmdEnsure();
    case 'update':
      return cmdUpdate(rest);
    case 'adopt':
      return cmdAdopt(rest);
    case 'install':
      return cmdInstall(rest);
    case 'uninstall':
      return cmdUninstall();
    case 'daemon':
      return cmdDaemon(); // never returns
    case '_attachment-validate':
      return cmdValidateAttachment();
    case '_run':
      return cmdRun(rest[0]); // hidden: in-session relaunch loop (tmux invokes this)
    case '_bootstrap':
      return cmdBootstrap(rest[0]); // hidden: pending Codex first-launch transaction
    case '_restart-worker':
      return cmdRestartWorker(rest[0]); // hidden: detached restart helper
    case '_restart-all-worker':
      return cmdRestartAllWorker(); // hidden: detached fleet-sweep driver (restart --all)
    case 'stop-hook':
      return cmdStopHook(); // hidden: Claude Stop-hook — injects deferred chat mail at end-of-turn
    case 'hook-status':
      return cmdHookStatus(); // hidden: Claude lifecycle hooks → working/idle status file
    case 'status-line':
      return cmdStatusLine(); // hidden: Claude statusLine tee → context% metrics + render original
    case 'control-native-stream':
      return cmdControlNativeStream();
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
