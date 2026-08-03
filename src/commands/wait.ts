import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { providerFor } from "../agent/index.ts";
import { capturePane, hasSession } from "../tmux/tmux.ts";
import { deferReady } from "../chat/deliver.ts";

/**
 * `ccmux wait <name>` — block until the session has VOLUNTARILY finished its turn, then exit 0.
 * The point is to replace "poll `ccmux list` in a loop and eyeball it": a script (or a person, or an
 * orchestrating agent) can just wait for the agent to be done.
 *
 * "Done" is the same condition the deferred-chat delivery uses (`deferReady`) — spinner off, the turn
 * ended on assistant TEXT, and the transcript has been still for the grace window — so `wait` and
 * `msg --defer` can never disagree about what "finished" means. Works with chat disabled; it needs
 * nothing but a running session.
 *
 * Exit codes: 0 = settled · 1 = unknown/not-running session or bad usage · 2 = timed out (distinct,
 * so a script can tell "still working" from "no such session").
 */
const DEFAULT_TIMEOUT_SEC = 300;
const POLL_MS = 1000;

export interface WaitOpts {
  timeoutSec: number;
  quiet: boolean;
}

/** Pure arg parsing — `--timeout N` (seconds), `--quiet`; bad/missing value falls back to the default. */
export function parseWaitOpts(args: string[]): WaitOpts {
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--timeout") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) timeoutSec = n;
    } else if (a === "--quiet" || a === "-q") quiet = true;
  }
  return { timeoutSec, quiet };
}

export async function cmdWait(name: string | undefined, args: string[] = []): Promise<number> {
  if (!name) {
    console.log("usage: ccmux wait <name> [--timeout N] [--quiet]   (exit 0 = turn finished, 2 = timed out)");
    return 1;
  }
  const o = parseWaitOpts(args);
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  if (!(await hasSession(m, name))) {
    console.error(`${name} is not running — start it first: ccmux start ${name}`);
    return 1;
  }
  const provider = providerFor(s);
  const deadline = Date.now() + o.timeoutSec * 1000;
  while (Date.now() < deadline) {
    const pane = await capturePane(m, name, 30);
    if (deferReady(m, s, provider, pane, Date.now())) {
      if (!o.quiet) console.log(`${name}: turn finished`);
      return 0;
    }
    await Bun.sleep(POLL_MS);
  }
  if (!o.quiet) console.error(`${name}: still working after ${o.timeoutSec}s (timed out)`);
  return 2;
}
