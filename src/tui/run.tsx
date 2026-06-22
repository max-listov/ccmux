import { render } from "ink";
import { loadMachineConfig } from "../config/machine.ts";
import { App } from "./App.tsx";
import type { Intent } from "./App.tsx";
import { createSession, waitReady } from "./actions.ts";
import { log, setStderrLogging, LOG_FILE } from "../util/log.ts";

function insideTmux(): boolean {
  return process.env.TMUX !== undefined && process.env.TMUX !== "";
}

/** Hand the terminal cleanly to tmux before attaching. The REAL fix is releasing stdin:
 *  Ink may leave it flowing after unmount, and a still-reading parent steals bytes from the
 *  inherited fd → tmux attach can't get exclusive control → broken render + exit 1.
 *  We do NOT re-send alt-screen/mouse resets — the App's own effects tear those down per-mode
 *  on unmount; re-sending `?1049l` in inline mode (never in alt-screen) garbles the buffer
 *  with stray chars. Only ensure raw mode is off and the cursor is visible. */
function cleanTerminalForAttach(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.stdin.pause();
  } catch {
    /* best effort */
  }
  process.stdout.write("\x1b[?25h"); // restore cursor (Ink hides it)
}

/** Hand the terminal to tmux for the session, block until detach, then return so the
 *  menu can re-render. Inside tmux we switch-client (returns at once) instead of nesting.
 *
 *  Uses Bun.spawnSync (NOT async spawn) on purpose. Root cause of the intermittent
 *  "attach then instantly exits (code 1)" / "breaks the moment you type" bug: with async
 *  spawn the parent's event loop keeps running while tmux is attached, and Bun/libuv still
 *  holds fd 0 (the terminal) — so the parent and the tmux client both poll the same tty and
 *  fight over input bytes and terminal setup. A plain shell `tmux attach` never hits this
 *  because the shell is blocked in waitpid for the whole attach, touching nothing. spawnSync
 *  reproduces exactly that: it freezes our event loop until tmux exits, so the tmux client is
 *  the sole owner of the terminal. Inherited fd 0/1/2 (not /dev/tty — VS Code's pty has no
 *  usable controlling terminal, so `open /dev/tty` fails there). */
function attachTmux(tmuxBin: string, name: string): void {
  const args = insideTmux() ? ["switch-client", "-t", `=${name}`] : ["attach", "-t", `=${name}`];
  log.info({ msg: "attach", name, mode: args[0], tty: process.stdout.isTTY, term: process.env.TERM });
  const r = Bun.spawnSync([tmuxBin, ...args], { stdin: "inherit", stdout: "inherit", stderr: "pipe" });
  const err = r.stderr ? r.stderr.toString().trim() : "";
  log.info({ msg: "attach exited", name, code: r.exitCode, stderr: err.slice(0, 300) });
}

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
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", onFatal("unhandledRejection"));
}

/** Die when the controlling terminal goes away, instead of orphaning. A closed VS Code/iTerm tab
 *  reparents us to PID 1; without this the render loop (kept alive by intervals) keeps re-rendering
 *  into a dead pty forever — a real incident: an orphaned TUI burned ~80% of a core for 14h. We
 *  can't rely on default signal behaviour (Ink/Bun swallow SIGHUP/SIGTERM — the orphan ignored
 *  plain `kill`), so we force exit ourselves on hangup OR the first failed stdout write (EIO on the
 *  dead tty) OR stdin EOF. process.exit is immediate, so a hung Ink teardown can't block it. */
function installExitOnTerminalDeath(): void {
  let dying = false;
  const die = (why: string): void => {
    if (dying) return;
    dying = true;
    log.info({ msg: "terminal died — exiting", why });
    try {
      cleanTerminalForAttach();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on("SIGHUP", () => die("SIGHUP"));
  process.on("SIGTERM", () => die("SIGTERM"));
  process.stdout.on("error", () => die("stdout error")); // EIO/EPIPE on a dead pty
  process.stdin.on("error", () => die("stdin error"));
  process.stdin.on("end", () => die("stdin end"));
}

export async function runTui(fullscreen: boolean): Promise<number> {
  setStderrLogging(false); // file-only — stderr would corrupt the Ink render
  installCrashTrail();
  installExitOnTerminalDeath();
  const m = loadMachineConfig();
  log.info({ msg: "tui start", fullscreen, insideTmux: insideTmux(), logFile: LOG_FILE });
  for (;;) {
    let app: ReturnType<typeof render> | undefined;
    try {
      const intent = await new Promise<Intent>((resolve) => {
        app = render(<App m={m} initialFullscreen={fullscreen} onIntent={resolve} />);
        void app.waitUntilExit().then(() => resolve({ type: "quit" }));
      });
      app?.unmount();
      // Wait for Ink to FINISH tearing down (raw-mode off, stdin listeners removed, alt-screen
      // restored) before we hand the terminal to tmux. unmount() only STARTS that teardown
      // asynchronously; waitUntilExit resolves once it's complete. Without this, `tmux attach`
      // spawns mid-teardown, Ink re-touches stdin under it, the client's socket handshake breaks
      // → "server exited unexpectedly" + exit 1 (intermittent, second try works). See attach race.
      await app?.waitUntilExit();
      log.info({ msg: "intent", type: intent.type, name: intent.type === "quit" ? undefined : intent.name });
      if (intent.type === "quit") return 0;
      const created = intent.type === "new" ? await createSession(m, intent.name, intent.dir) : undefined;
      if (created) log.info({ msg: "created", name: created.name, dir: created.dir, uuid: created.uuid });
      cleanTerminalForAttach();
      if (created) {
        const t0 = Date.now();
        await waitReady(m, created); // attach to a drawn agent, not a half-booted blank pane
        log.info({ msg: "waitReady done", name: created.name, ms: Date.now() - t0 });
      }
      attachTmux(m.tmuxBin, intent.name);
      if (insideTmux()) return 0; // switch-client doesn't block — no menu to come back to
    } catch (err) {
      app?.unmount();
      cleanTerminalForAttach();
      log.error({ msg: "tui loop error", err: String(err), stack: err instanceof Error ? err.stack : undefined });
      return 1;
    }
  }
}
