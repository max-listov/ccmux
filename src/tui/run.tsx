import { render } from 'ink';
import { loadMachineConfig } from '../config/machine.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { wakeBeforeAttach } from '../session/sleep/operations.ts';
import { attachTmux, cleanTerminalForAttach, insideTmux } from '../tmux/attach.ts';
import { LOG_FILE, log, setStderrLogging } from '../util/log.ts';
import type { Intent } from './App.tsx';
import { App } from './App.tsx';
import { createSession, waitReady } from './actions.ts';
import { ignoreTerminalStops } from './terminalStops.ts';

/** Last-resort crash trail: the TUI owns the terminal, so an uncaught throw would vanish.
 *  Log it to the file (always tailable) and restore the terminal so the shell isn't wedged. */
function installCrashTrail(): void {
  const onFatal = (kind: string) => (err: unknown) => {
    log.error({ msg: kind, err: String(err), stack: err instanceof Error ? err.stack : undefined });
    try {
      cleanTerminalForAttach();
    } catch {
      /* best effort */
    }
  };
  process.on('uncaughtException', onFatal('uncaughtException'));
  process.on('unhandledRejection', onFatal('unhandledRejection'));
}

/** Die when the controlling terminal goes away, instead of orphaning. A closed VS Code/iTerm tab
 *  reparents us to PID 1; without this the render loop (kept alive by intervals) keeps re-rendering
 *  into a dead pty forever — a real incident: an orphaned TUI burned ~80% of a core for 14h. We
 *  can't rely on default signal behaviour (Ink/Bun swallow SIGHUP/SIGTERM — the orphan ignored
 *  plain `kill`), so we force exit ourselves on hangup OR the first failed stdout write (EIO on the
 *  dead tty) OR stdin EOF. process.exit is immediate, so a hung Ink teardown can't block it.
 *
 *  The way out must not be stoppable. A closing terminal tab can hand the foreground back to the
 *  shell before the hangup reaches us; from the background, switching raw mode off (`tcsetattr`) makes
 *  the kernel STOP the process with SIGTTOU — and not only our own restore does it: Ink's exit hook
 *  (`signal-exit` → unmount) does the same. The `dying` latch then swallows every later signal and the
 *  process stays stopped for good, an ownerless orphan in state `T`. So the first thing `die` does is
 *  ignore the terminal job-control stops; an ignored SIGTTOU lets the call go through instead. When
 *  the terminal is what died, we do not restore it ourselves — there is nothing left to restore. */
function installExitOnTerminalDeath(): void {
  let dying = false;
  const die = (why: string, terminalAlive: boolean): void => {
    if (dying) return;
    dying = true;
    ignoreTerminalStops();
    log.info({ msg: 'terminal died — exiting', why });
    if (terminalAlive) {
      try {
        cleanTerminalForAttach();
      } catch {
        /* best effort */
      }
    }
    process.exit(0);
  };
  process.on('SIGHUP', () => die('SIGHUP', false));
  process.on('SIGTERM', () => die('SIGTERM', true));
  process.stdout.on('error', () => die('stdout error', false)); // EIO/EPIPE on a dead pty
  process.stdin.on('error', () => die('stdin error', false));
  process.stdin.on('end', () => die('stdin end', false));
}

export async function runTui(fullscreen: boolean): Promise<number> {
  setStderrLogging(false); // file-only — stderr would corrupt the Ink render
  installCrashTrail();
  installExitOnTerminalDeath();
  const m = loadMachineConfig();
  log.info({ msg: 'tui start', fullscreen, insideTmux: insideTmux(), logFile: LOG_FILE });
  for (;;) {
    let app: ReturnType<typeof render> | undefined;
    try {
      const intent = await new Promise<Intent>((resolve) => {
        app = render(<App m={m} initialFullscreen={fullscreen} onIntent={resolve} />);
        void app.waitUntilExit().then(() => resolve({ type: 'quit' }));
      });
      app?.unmount();
      // Wait for Ink to FINISH tearing down (raw-mode off, stdin listeners removed, alt-screen
      // restored) before we hand the terminal to tmux. unmount() only STARTS that teardown
      // asynchronously; waitUntilExit resolves once it's complete. Without this, `tmux attach`
      // spawns mid-teardown, Ink re-touches stdin under it, the client's socket handshake breaks
      // → "server exited unexpectedly" + exit 1 (intermittent, second try works). See attach race.
      await app?.waitUntilExit();
      log.info({
        msg: 'intent',
        type: intent.type,
        name: intent.type === 'quit' ? undefined : intent.name,
      });
      if (intent.type === 'quit') return 0;
      const created =
        intent.type === 'new'
          ? await createSession(m, intent.name, intent.dir, intent.agent)
          : undefined;
      if (created)
        log.info({ msg: 'created', name: created.name, dir: created.dir, uuid: created.uuid });
      cleanTerminalForAttach();
      if (created) {
        const t0 = Date.now();
        await waitReady(m, created); // attach to a drawn agent, not a half-booted blank pane
        log.info({ msg: 'waitReady done', name: created.name, ms: Date.now() - t0 });
      } else if (intent.type === 'attach') {
        const existing = findSession(loadSessions(m), intent.name);
        const t0 = Date.now();
        if (
          existing !== undefined &&
          (await wakeBeforeAttach(m, existing, (line) => process.stderr.write(line)))
        )
          log.info({ msg: 'wake on attach done', name: existing.name, ms: Date.now() - t0 });
      }
      attachTmux(m, intent.name);
      if (insideTmux()) return 0; // switch-client doesn't block — no menu to come back to
    } catch (err) {
      app?.unmount();
      cleanTerminalForAttach();
      log.error({
        msg: 'tui loop error',
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      process.stderr.write(`stitchmux: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
}
