import { loadSessions, findSession } from "../config/sessions.ts";
import { providerFor } from "../agent/index.ts";
import { capturePane, hasSession } from "../tmux/tmux.ts";
import { deferReady } from "../chat/deliver.ts";
import { forwardIfRemote } from "../fleet/forward.ts";
import { loadLedger, loadCursors, loadAckedIds, unreadFor } from "../chat/store.ts";
import type { MachineConfig, ChatMessage } from "../types.ts";

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

/** Chat addressed to this session that the daemon has not injected yet. Read fresh on every poll:
 *  mail can arrive mid-wait, and a wait that ignored it would answer about the wrong turn. */
function pendingInbound(m: MachineConfig, name: string): { msg: ChatMessage }[] {
  try {
    return unreadFor(name, loadLedger(m), loadCursors(m), loadAckedIds(m));
  } catch {
    // Chat is optional; a missing or unreadable ledger must never break a plain `wait`.
    return [];
  }
}

export async function cmdWait(name: string | undefined, args: string[] = []): Promise<number> {
  if (!name) {
    console.log("usage: ccmux wait <name> [--timeout N] [--quiet]   (exit 0 = turn finished, 2 = timed out)");
    return 1;
  }
  // The remote `wait` blocks for ITS OWN timeout, so the ssh deadline has to sit above it. With the
  // transport default (30s) a perfectly healthy link was killed mid-wait and reported as
  // "transport failed" for any worker that took longer — turning the primary cross-machine use case
  // into a false alarm. +30s covers connection setup and the remote's own exit.
  const fwd = await forwardIfRemote(name, "wait", args, { timeoutMs: (parseWaitOpts(args).timeoutSec + 30) * 1000 });
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const o = parseWaitOpts(args);
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
    // Undelivered mail means the work has not STARTED, and an idle pane is therefore not an
    // answer. Without this, the documented recipe raced itself: `msg` queues, the daemon delivers
    // a beat later, and a `wait` fired immediately after returned "turn finished" in under a
    // second — reporting a finished turn that had never begun (observed on a live cross-machine
    // hand-off). Anything still pending for this recipient keeps it unsettled.
    if (pendingInbound(m, name).length === 0 && deferReady(m, s, provider, pane, Date.now())) {
      if (!o.quiet) console.log(`${name}: turn finished`);
      return 0;
    }
    await Bun.sleep(POLL_MS);
  }
  if (!o.quiet) console.error(`${name}: still working after ${o.timeoutSec}s (timed out)`);
  return 2;
}
