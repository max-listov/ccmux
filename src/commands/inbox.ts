import { forwardIfRemote } from "../fleet/forward.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { loadLedger, loadCursors, loadAckedIds, unreadFor, markRead, fmtMessage, OWNER } from "../chat/store.ts";
import { providerFor } from "../agent/index.ts";
import { holdReason } from "../chat/holdReason.ts";
import { readChatHold } from "../agent/sessionStatus.ts";
import { listSessionNames } from "../tmux/tmux.ts";
import { managedPeer } from "../chat/identity.ts";

/**
 * Show a session's still-undelivered chat and, for each message, WHY it hasn't landed yet.
 *
 * The reason is the point: "it just never arrived" is what turned a mis-addressed report into hours
 * of cross-machine archaeology. Now the sender is told plainly — recipient stopped, chat off,
 * scheduled for later, waiting for the turn to end, a human typing in that pane, or simply queued.
 *
 * Marking read is deliberately limited to YOUR OWN session: reading someone else's inbox is a
 * diagnostic act, and advancing their cursor would hide the mail from the agent that must receive it.
 *   ccmux inbox [name] [--peek]
 */
export async function cmdInbox(args: string[]): Promise<number> {
  const self = process.env.CCMUX_SESSION;
  const peek = args.includes("--peek");
  let name = args.find((a) => !a.startsWith("--")) ?? self;
  if (name === undefined || name === "") {
    console.log("usage: ccmux inbox <name> [--peek]   (name defaults to CCMUX_SESSION)");
    return 1;
  }
  const fwd = await forwardIfRemote(name, "inbox", peek ? ["--peek"] : []);
  if (fwd.done) return fwd.code;
  const m = fwd.m;
  name = fwd.session;
  const recipient = findSession(loadSessions(m), name);
  if (recipient === undefined) {
    console.error(`no such session: ${name}`);
    return 1;
  }
  const peer = managedPeer(m.rcPrefix, recipient);
  const ledger = loadLedger(m);
  // Consult the ack-log: conditional mail is delivered OFF the read cursor, so without this an
  // already-injected deferred message would be reported as pending forever.
  const unread = unreadFor(peer, ledger, loadCursors(m), loadAckedIds(m));
  if (unread.length === 0) {
    console.log(`(${name}: no unread messages)`);
  } else {
    const running = (await listSessionNames(m)).has(name);
    const daemonHold = readChatHold(name);
    const now = Date.now();
    const ctx = {
      recipient,
      running,
      nowMs: now,
      isOwner: name === OWNER,
      chatDeliverable: providerFor(recipient).chatDeliverable !== undefined,
      daemonHold,
    };
    for (const { msg } of unread) {
      console.log(fmtMessage(msg));
      console.log(`    ↳ held: ${holdReason(msg, ctx).text}`);
    }
  }
  // Never advance another session's cursor — that would hide its mail behind your diagnosis.
  const isSelf = self !== undefined && self === name;
  if (!peek && isSelf) await markRead(m, peer, ledger.length);
  return 0;
}
