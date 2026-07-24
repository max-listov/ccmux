import { randomUUID } from "node:crypto";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { appendMessage, CLI, OWNER } from "../chat/store.ts";
import { log } from "../util/log.ts";

/**
 * Send a chat message. You pick only the RECIPIENT — the sender is AUTOMATIC and cannot be spoofed:
 * an agent sends as its own session (env CCMUX_SESSION), a command-line invocation sends as `cli`.
 * There is no `--from`. Recipient is another session (delivered to its pane + mirrored to Telegram)
 * or the reserved `owner` (the human — Telegram-only, no pane). A sending session must be chat-enabled.
 *
 *   ccmux msg <to|owner> <text...> [--task <name>]
 */
export async function cmdMsg(args: string[]): Promise<number> {
  // Sender = this agent session, or `cli` from a shell. Automatic — never chosen by the caller.
  const ccmuxSession = process.env.CCMUX_SESSION;
  const from = ccmuxSession !== undefined && ccmuxSession !== "" ? ccmuxSession : CLI;

  const positionals: string[] = [];
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
    if (a !== undefined) positionals.push(a);
  }
  const notBefore = afterSec !== null ? new Date(Date.now() + afterSec * 1000).toISOString() : null;
  const to = positionals[0];
  const body = positionals.slice(1).join(" ").trim();

  if (to === undefined || body === "") {
    console.log("usage: ccmux msg <to|owner> <text...> [--task <name>] [--defer] [--after <sec>] [--on-behalf-of <who>]   (sender is automatic: this session, or 'cli')");
    return 1;
  }

  const m = loadMachineConfig();
  const sessions = loadSessions(m);

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
  }

  appendMessage(m, { id: randomUUID(), ts: new Date().toISOString(), from, to, body, task, defer, onBehalfOf, notBefore });
  log.info({ msg: "chat message sent", from, to, task, defer, onBehalfOf, notBefore });
  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  const when = notBefore !== null ? ` (after ${afterSec}s)` : defer ? " (deferred)" : "";
  console.log(`sent ${from} → ${to}${when}: ${preview}`);
  return 0;
}
