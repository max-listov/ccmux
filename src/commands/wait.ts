import { loadSessions, findSession } from "../config/sessions.ts";
import { providerFor } from "../agent/index.ts";
import { capturePane, hasSession } from "../tmux/tmux.ts";
import { readTurnState } from "../chat/deliver.ts";
import { WHY_TEXT, type TurnWhy } from "../chat/turnState.ts";
import { notBeforeDue } from "../chat/deliver.ts";
import { forwardIfRemote } from "../fleet/forward.ts";
import { loadLedger, loadCursors, loadAckedIds, unreadFor } from "../chat/store.ts";
import type { MachineConfig, ChatMessage, Session } from "../types.ts";

/**
 * `ccmux wait <name>` — block until the session is BETWEEN TURNS, then exit 0.
 * The point is to replace "poll `ccmux list` in a loop and eyeball it": a script (or a person, or an
 * orchestrating agent) can just wait for the agent to be done.
 *
 * "Done" is the one condition deferred-chat delivery uses (`turnState`), so `wait` and `msg --defer`
 * can never disagree about what "between turns" means. It covers the case a turn-ended test alone
 * cannot: a turn that was KILLED (restart or interrupt mid-work) never produces the ending it would
 * be waiting for, so `wait` used to run to its timeout on a session that was plainly idle. Both
 * settle paths exit 0 — a third code would break existing scripts — but they read differently,
 * because after an interrupted turn the documented next step (`transcript --last-message`) hands
 * back the text from BEFORE the unfinished tool calls. Works with chat disabled; it needs nothing
 * but a running session.
 *
 * Exit codes: 0 = settled · 1 = unknown/not-running session or bad usage · 2 = timed out (distinct,
 * so a script can tell "still working" from "no such session").
 */
const DEFAULT_TIMEOUT_SEC = 300;
const POLL_MS = 1000;
/** How long a session must stay absent before `wait` calls it gone — comfortably longer than a
 *  restart's kill→relaunch gap, so a fleet sweep does not look like a disappearance. */
const GONE_MS = 45_000;

/** What exit 0 MEANS in each case. All three are "between turns", but only one of them is an answer
 *  to "did it finish the work" — after an interrupted turn `transcript --last-message` hands back
 *  what was said BEFORE the tool calls that never completed. */
const SETTLED_TEXT: Record<string, string> = {
  "turn-ended": "turn finished",
  "idle-after-interrupt": "idle — its last turn was interrupted, not completed (any report you read is from before that)",
  "never-spoke": "idle — it has not taken a turn yet",
};

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

/**
 * Chat addressed to this session that is both undelivered AND actually on its way — read fresh on
 * every poll, because mail can arrive mid-wait and a wait that ignored it would answer about the
 * wrong turn.
 *
 * Two kinds of mail are deliberately NOT counted, because waiting on them is waiting on something
 * that cannot happen now (or ever):
 *  - **not due yet** — a router arms its own watchdog with `--after 600`; counting that would make
 *    every `wait` on that router useless for ten minutes while it sits idle;
 *  - **never deliverable** — the recipient has chat off, or its agent has no way to receive chat, so
 *    the daemon skips it forever. `holdReason` already calls this permanent; `wait` must agree.
 */
export function mailBlocksSettle(
  unread: ChatMessage[],
  opts: { chatEnabled: boolean; canReceiveChat: boolean; nowMs: number },
): ChatMessage[] {
  if (!opts.chatEnabled || !opts.canReceiveChat) return [];
  return unread.filter((msg) => notBeforeDue(msg, opts.nowMs));
}

function blockingInbound(m: MachineConfig, s: Session, name: string, nowMs: number): ChatMessage[] {
  try {
    return mailBlocksSettle(
      unreadFor(name, loadLedger(m), loadCursors(m), loadAckedIds(m)).map((u) => u.msg),
      { chatEnabled: s.chatEnabled, canReceiveChat: providerFor(s).chatDeliverable !== undefined, nowMs },
    );
  } catch {
    // Chat is optional; a missing or unreadable ledger must never break a plain `wait`.
    return [];
  }
}

export async function cmdWait(name: string | undefined, args: string[] = []): Promise<number> {
  if (!name) {
    console.log("usage: ccmux wait <name> [--timeout N] [--quiet]   (exit 0 = between turns, 2 = timed out)");
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
  let missingSince: number | null = null;
  let lastWhy: TurnWhy | null = null;
  while (Date.now() < deadline) {
    // Liveness is re-checked every pass, not once at the start: a session stopped mid-wait (a fleet
    // restart sweep, say) used to run to the deadline and then report "still working" about a
    // session that was not running at all.
    if (await hasSession(m, name)) {
      missingSince = null;
    } else {
      // A restart makes the session absent for a few seconds (kill → relaunch), and `restart --all`
      // walks the whole fleet doing exactly that. Failing on the first miss would tell an
      // orchestrator to give up on a peer that is back three seconds later, so absence has to
      // PERSIST before it counts — and even then it is a timeout, not "no such session".
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= GONE_MS) {
        if (!o.quiet) console.error(`${name}: gone for ${Math.round(GONE_MS / 1000)}s while waiting — not running`);
        return 2;
      }
      await Bun.sleep(POLL_MS);
      continue;
    }
    const now = Date.now();
    const pane = await capturePane(m, name, 40);
    // Undelivered mail means the work has not STARTED, and an idle pane is therefore not an answer.
    // Without this the documented recipe raced itself: `msg` queues, the daemon delivers a beat
    // later, and a `wait` fired immediately after reported a finished turn that had never begun.
    if (blockingInbound(m, s, name, now).length === 0) {
      const ts = readTurnState(m, s, provider, pane, now);
      if (ts.settled) {
        // Both settle paths exit 0 — a third exit code would break every existing script — but the
        // line must not claim a turn "finished" when it was killed: the documented next step is
        // `transcript --last-message`, which would then hand back the text from BEFORE the tool
        // calls that never completed, as if it were the answer.
        if (!o.quiet) console.log(`${name}: ${SETTLED_TEXT[ts.why]}`);
        return 0;
      }
      lastWhy = ts.why;
    }
    await Bun.sleep(POLL_MS);
  }
  // Say WHAT it was doing. "Still working" was a guess, and a false one for a session parked at a
  // permission prompt — which now blocks the full timeout and used to be described as busy.
  if (!o.quiet) console.error(`${name}: timed out after ${o.timeoutSec}s — ${lastWhy === null ? "waiting on undelivered mail" : WHY_TEXT[lastWhy]}`);
  return 2;
}
