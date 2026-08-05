import { randomUUID } from "node:crypto";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { appendMessage, appendAck, loadAckedIds, loadLedger, pendingConditional, CLI, OWNER } from "../chat/store.ts";
import { usageLine } from "./help.ts";
import { log } from "../util/log.ts";
import { routeFor, parseOrigin } from "../fleet/address.ts";
import { runRemote, relay } from "../fleet/transport.ts";
import { appendOutbound } from "../fleet/outbox.ts";
import { providerFor } from "../agent/index.ts";
import { preview } from "../util/preview.ts";

/**
 * Send a chat message. You pick only the RECIPIENT — the sender is AUTOMATIC and cannot be spoofed:
 * an agent sends as its own session (env CCMUX_SESSION), a command-line invocation sends as `cli`.
 * There is no `--from`. Recipient is another session (delivered to its pane + mirrored to Telegram)
 * or the reserved `owner` (the human — Telegram-only, no pane). A sending session must be chat-enabled.
 *
 *   ccmux msg <to|owner> <text...> [--task <name>] [--defer] [--after <sec>] [--on-behalf-of <who>]
 *   ccmux msg cancel <task>        — drop this sender's still-undelivered mail for a task
 *   echo "…" | ccmux msg <to>      — body from stdin
 */
export async function cmdMsg(args: string[]): Promise<number> {
  // Sender = this agent session, or `cli` from a shell. Automatic — never chosen by the caller.
  const ccmuxSession = process.env.CCMUX_SESSION;
  const from = ccmuxSession !== undefined && ccmuxSession !== "" ? ccmuxSession : CLI;

  // Subcommand: `ccmux msg cancel <task>` — tombstone THIS sender's undelivered conditional mail for
  // that task (an armed watchdog / a queued defer that hasn't fired). Scoped to `from` so a session
  // can never cancel another's dispatches. Already-delivered mail is untouched (can't be un-sent).
  if (args[0] === "cancel") {
    const task = args[1];
    if (task === undefined || task === "") {
      console.log("usage: ccmux msg cancel <task>   (drops your still-undelivered mail for that task)");
      return 1;
    }
    const m = loadMachineConfig();
    const pending = pendingConditional(loadLedger(m), loadAckedIds(m), { from, task });
    for (const p of pending) appendAck(m, p.id, "cancel", p.to);
    log.info({ msg: "chat cancel", from, task, cancelled: pending.length });
    console.log(`cancelled ${pending.length} undelivered message(s) from ${from} for task '${task}'`);
    return 0;
  }

  const positionals: string[] = [];
  const originArg = process.env.CCMUX_ORIGIN ?? null;
  let task: string | null = null;
  let defer = false;
  let onBehalfOf: string | null = null;
  let afterSec: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--task") {
      task = args[++i] ?? null;
      continue;
    }
    // Deferred delivery: hold until the recipient voluntarily finishes its turn (never mid-work).
    if (a === "--defer") {
      defer = true;
      continue;
    }
    // Honest provenance for a relayed instruction (router → target on behalf of the owner).
    if (a === "--on-behalf-of") {
      onBehalfOf = args[++i] ?? null;
      continue;
    }
    // Time-delayed delivery: not before N seconds from now (a router's self-watchdog timer).
    if (a === "--after") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.log("msg: --after needs a positive number of seconds");
        return 1;
      }
      afterSec = n;
      continue;
    }
    // An unknown --flag used to be swallowed into the body as text, so a typo (or a flag a
    // not-yet-updated machine doesn't know) silently became part of the message. Refuse instead.
    if (a !== undefined && a.startsWith("--")) {
      console.log(`msg: unknown flag '${a}'\n${usageLine("msg")}`);
      return 1;
    }
    if (a !== undefined) positionals.push(a);
  }
  const notBefore = afterSec !== null ? new Date(Date.now() + afterSec * 1000).toISOString() : null;
  let to = positionals[0];
  let body = positionals.slice(1).join(" ").trim();

  // stdin fallback: `echo "…" | ccmux msg <to>` — with a recipient but no inline body, read the body
  // from a pipe (matches `tool tg`). Only when stdin is NOT a TTY, so an interactive shell with a
  // missing body still gets the usage error instead of hanging on the terminal.
  if (body === "" && to !== undefined && !process.stdin.isTTY) {
    body = (await Bun.stdin.text().catch(() => "")).trim();
  }

  if (to === undefined || body === "") {
    console.log(usageLine("msg"));
    return 1;
  }

  const m = loadMachineConfig();
  const sessions = loadSessions(m);

  // `CCMUX_ORIGIN` names the machine+session a message came from when this invocation arrived over
  // ssh. It rides the ENVIRONMENT rather than a flag on purpose (see `runRemote`): an older ccmux
  // ignores an unknown variable, whereas an unknown flag would have become the message body.
  // It is a routing LABEL, not a credential — see `parseOrigin` for what it does and does not claim.
  let fromMachine: string | null = null;
  let fromName = from;
  if (originArg !== null) {
    const o = parseOrigin(originArg, from !== CLI, [OWNER]);
    if ("error" in o) {
      console.log(o.error);
      return 1;
    }
    fromMachine = o.machine;
    fromName = o.session;
  }

  // A sending SESSION must exist and be chat-enabled; `cli` (the command line) is always allowed.
  const sender = from === CLI ? undefined : findSession(sessions, from);
  if (from !== CLI && (!sender || !sender.chatEnabled)) {
    console.log(`msg: this session '${from}' has chat disabled — enable with: ccmux chat on ${from}`);
    return 1;
  }

  // Provenance gate: relaying "--on-behalf-of" (elevating a message to someone else's authority) is
  // limited to the human at the CLI and to ROUTER sessions. A plain peer must not be able to forge
  // owner authority — `from` is always the true unspoofable sender, but the AUTHORITY tag is gated.
  if (onBehalfOf !== null && from !== CLI && !sender?.promptModules.includes("router")) {
    console.log(`msg: only a router session may use --on-behalf-of (this session '${from}' is not a router)`);
    return 1;
  }

  // ── fleet routing ─────────────────────────────────────────────────────────────────────────────
  // Deliberately AFTER the local authority gates above: the sender-must-be-chat-enabled and the
  // router-only `--on-behalf-of` checks are enforced on the machine the message LEAVES, because the
  // receiving machine sees only `cli` and could not enforce them. Interception in cli.ts dispatch
  // would skip both — hence it lives here, not there.
  const route = routeFor(to, m);
  if (route.kind === "error") {
    console.error(route.message);
    return 1;
  }
  if (route.kind === "remote") {
    if (to.endsWith(`:${OWNER}`) || to.endsWith(`:${CLI}`)) {
      console.error(`msg: '${OWNER}'/'${CLI}' are not machine-scoped — use: ccmux msg ${OWNER}`);
      return 1;
    }
    // Conditional delivery is deliberately LOCAL-ONLY in v1. Its bookkeeping (task dedup and
    // `msg cancel`) keys on the sender within ONE ledger, and a cross-machine send lands in the
    // REMOTE ledger as `cli`: two different remote senders would tombstone each other's mail, and
    // the originator could never cancel its own. Refusing loudly beats a silent wrong outcome.
    if (defer || notBefore !== null) {
      console.error("msg: --defer/--after are local-only (cross-machine mail is delivered immediately) — send it plain, or run the conditional send on that machine");
      return 1;
    }
    // Carry the sender's address across the hop — including for a plain shell (`host-a:cli`), which
    // used to arrive as a bare `cli` with no machine at all, leaving the recipient exactly as unable
    // to answer as before. The transport is the only writer: a local agent setting this itself is
    // refused (see `parseOrigin`).
    const remoteArgs = [route.session, ...(task !== null ? ["--task", task] : []), ...(onBehalfOf !== null ? ["--on-behalf-of", onBehalfOf] : [])];
    // ONE id for this message, minted here and carried across the hop, so the outbox row and the
    // remote ledger entry are the same letter. That identity is what makes a later retry safe:
    // the receiver skips an id it has already stored, so re-sending can never duplicate — including
    // the nasty case where the first attempt DID land and only our side read it as a failure.
    const id = randomUUID();
    // Body travels on STDIN, never in the command line: `msg` already reads a piped body, so quotes,
    // newlines, `$` and backticks in the text cannot corrupt or inject on the remote shell.
    const r = await runRemote(route.alias, ["ccmux", "msg", ...remoteArgs], {
      stdin: body,
      env: { CCMUX_ORIGIN: `${m.rcPrefix}:${from}`, CCMUX_MSG_ID: id },
    });
    // Record the SEND on this side, success or failure — without it the initiator has no trace that
    // it ever asked, and "waiting for a report" exists only in an agent's head.
    appendOutbound(m, {
      id,
      ts: new Date().toISOString(),
      from,
      toMachine: route.machine,
      toSession: route.session,
      kind: "msg",
      body,
      task,
      ok: !r.transportFailed && r.code === 0,
      detail: r.transportFailed ? "transport failed" : r.code === 0 ? "" : `remote exit ${r.code}`,
    });
    return relay(r, `msg ${to}`);
  }
  // Local route: an address naming THIS machine (`<own-prefix>:name`) is just the local session —
  // strip the prefix so recipient lookup, the ledger and every downstream reader see the plain name.
  to = route.session;

  // Recipient: `owner` = the human (Telegram-only, no pane); otherwise a chat-enabled session.
  if (to === OWNER) {
    if (m.telegram === undefined) {
      console.log("msg: note — no telegram configured, so 'owner' won't receive this now (kept in the ledger).");
    }
  } else {
    const target = findSession(sessions, to);
    if (!target) {
      console.log(`msg: no such session '${to}' on this machine (or use 'owner' to message the human)`);
      return 1;
    }
    if (!target.chatEnabled) {
      console.log(`msg: recipient '${to}' has chat disabled — enable with: ccmux chat on ${to}`);
      return 1;
    }
    // Refuse a recipient whose agent has no "is this pane safe to inject into" detector: the daemon
    // skips such sessions entirely, so the message would sit in the ledger forever while the sender
    // believed it was sent. Fail at the door instead of accumulating undeliverable mail.
    if (providerFor(target).chatDeliverable === undefined) {
      console.log(`msg: recipient '${to}' runs ${target.agent}, which cannot receive chat (no safe-to-inject detector for its pane) — nothing would ever be delivered`);
      return 1;
    }
  }

  // Trap warning: `--after` + `--defer` multiply — "not before T" AND "only at a turn boundary". A
  // sender in a long turn (a router polling/validating almost always is) won't get such a self-ping
  // on time; the Stop hook fires only when the turn ENDS. A watchdog should use bare `--after`, which
  // the daemon delivers between tool calls. Not blocked (they're compatible) — just steer.
  if (afterSec !== null && defer) {
    console.log("msg: note — --after with --defer only arrives at the recipient's next turn boundary; a self-watchdog should use bare --after (delivered between tool calls, not held for end-of-turn).");
  }

  // Dedup by task: a re-armed conditional (defer/after) with the same (from, to, task) REPLACES the
  // sender's prior still-undelivered one — so re-arming a watchdog with the same --task can't pile up
  // duplicate pings (the router's core pain). Tombstone the priors, then append the fresh one.
  if ((defer || notBefore !== null) && task !== null) {
    const priors = pendingConditional(loadLedger(m), loadAckedIds(m), { from, to, task });
    for (const p of priors) appendAck(m, p.id, "cancel", p.to);
    if (priors.length > 0) log.info({ msg: "chat dedup — replaced prior pending", from, to, task, replaced: priors.length });
  }

  // A carried id means this letter already has an identity on the SENDER's side. Honouring it (and
  // refusing a repeat) is what turns a retry into a no-op instead of a duplicate. Only the transport
  // can set it — the same gate as the origin, since both arrive together over ssh.
  const carriedId = originArg !== null ? (process.env.CCMUX_MSG_ID ?? null) : null;
  if (carriedId !== null && loadLedger(m).some((x) => x.id === carriedId)) {
    console.log(`already delivered (${carriedId}) — retry ignored`);
    return 0; // success: the letter IS there, which is what the sender wanted to know
  }
  appendMessage(m, { id: carriedId ?? randomUUID(), ts: new Date().toISOString(), from: fromName, fromMachine, to, body, task, defer, onBehalfOf, notBefore });
  log.info({ msg: "chat message sent", from: fromName, fromMachine, to, task, defer, onBehalfOf, notBefore });
  const when = notBefore !== null ? ` (after ${afterSec}s)` : defer ? " (deferred)" : "";
  console.log(`sent ${fromMachine !== null ? `${fromMachine}:${fromName}` : fromName} → ${to}${when}: ${preview(body)}`);
  return 0;
}
