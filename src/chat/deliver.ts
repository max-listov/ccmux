import { loadSessions } from "../config/sessions.ts";
import { providerFor, lastTranscriptMessage, lastActivityMs, type AgentProvider } from "../agent/index.ts";
import { capturePaneStyled, stripAnsi, clientTypingRecently, listSessionNames, pasteText, sendKeysLiteral, sendKeysNamed } from "../tmux/tmux.ts";
import type { ChatMessage, MachineConfig, Session } from "../types.ts";
import { log } from "../util/log.ts";
import { turnState, WHY_TEXT, type TurnState } from "./turnState.ts";
import { promptInvocation } from "../env.ts";
import { formatChatInjection } from "./format.ts";
import { appendAck, loadAckedIds, loadCursors, loadLedger, saveCursors } from "./store.ts";
import { writeChatHold, clearChatHold } from "../agent/sessionStatus.ts";
import { managedPeer, managedPeerKey, principalLabel } from "./identity.ts";
import { chatEnabledFor } from "../config/chat.ts";

// Backstop against a runaway (e.g. an A→B→A loop): a single pass delivers at most this many
// messages fleet-wide. Combined with one-message-per-recipient-per-pass, chat can't flood a tick.
const MAX_PER_PASS = 20;

// Loop/rate guard: hold delivery once a recipient has received more than this many messages within
// the rolling window. A runaway A→B→A ping-pong inflates BOTH sides' inbound rate → both pause →
// the loop breaks. Generous for a "phone call" channel; a genuine burst just spreads over time.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_INBOUND = 12;

/** Messages addressed to `name` sent within the window (by ledger `ts`). Pure — `nowMs` passed in. */
export function recentInboundCount(recipient: ReturnType<typeof managedPeer>, ledger: ChatMessage[], nowMs: number): number {
  let n = 0;
  for (const msg of ledger) {
    if (msg.to.kind !== "managed" || managedPeerKey(msg.to) !== managedPeerKey(recipient)) continue;
    const t = Date.parse(msg.ts);
    if (Number.isFinite(t) && nowMs - t <= RATE_WINDOW_MS) n += 1;
  }
  return n;
}

/** Inject a message into the recipient's pane as its next user turn, tagged so the agent knows it's
 *  a PEER message, not the human (shared framer — same tag the Stop hook uses). Bracketed paste keeps
 *  a multi-line body intact (no early submit); falls back to a newline-collapsed literal on failure. */
async function deliverToPane(m: MachineConfig, name: string, msg: ChatMessage): Promise<boolean> {
  // replyable = we can actually route back to the sender's machine from here (it is us, or it is in
  // our fleet map) — otherwise we print the address without a command that would fail on this box.
  const replyable = msg.from.kind === "managed" && (msg.from.machine === m.rcPrefix || m.fleet?.[msg.from.machine] !== undefined);
  const text = formatChatInjection(msg, { cli: promptInvocation(), replyable });
  if (!(await pasteText(m, name, text)) && !(await sendKeysLiteral(m, name, text.replace(/\r?\n+/g, " ⏎ ")))) {
    return false; // the pane is gone (killed between our sample and this write) — nothing was typed
  }
  await Bun.sleep(150); // let the paste/text land before the separate Enter
  // The Enter is what SUBMITS it. If the session died in the 150ms gap the text is stranded in a
  // composer nobody will read, so this is the honest place to say "not delivered".
  return sendKeysNamed(m, name, "Enter");
}

// The Stop hook delivers a deferred message the instant a turn ends; this daemon path is the
// backbone for a target that was ALREADY between turns when the message arrived — including one
// whose turn was killed, for which no Stop is ever coming (see `turnState`).
// How recently a keystroke means "still typing" — long enough to bridge the gap between two keys,
// short enough that simply watching a pane never blocks delivery.
const TYPING_WINDOW_SEC = 3;

/** Gather what `turnState` needs from this session's pane and transcript. The IO lives here so the
 *  decision itself stays pure and testable — the previous version was neither, which is how it
 *  shipped waiting on an event that a killed turn can never produce. */
export function readTurnState(m: MachineConfig, s: Session, provider: AgentProvider, pane: string, nowMs: number): TurnState {
  const scan = provider.scanPane(pane);
  const lm = lastTranscriptMessage(s, m);
  const mt = lastActivityMs(s, m);
  return turnState({
    paneWorking: scan.state === "working",
    // `ready` is a HARD gate here, so it may only be trusted from a provider whose pane detectors are
    // calibrated. `chatDeliverable` is that marker: an agent that can say "this pane is safe to type
    // into" has had its chrome mapped; one that cannot has not. Treating an unreliable "not drawn" as
    // a permanent block would recreate the very hang this change removes, on another agent.
    paneReady: provider.chatDeliverable === undefined ? true : scan.ready,
    // Honest limitation: a provider with no menu detector gets `false` — we cannot see a menu we have
    // no pattern for. For chat that is harmless (deliverPending skips such agents entirely); for
    // `wait` it means the menu guard simply does not exist on that agent, which is a gap in the
    // agent's pane support, not something this function can invent.
    atMenu: provider.chatDeliverable?.(pane) === false,
    endedOnAssistantText: lm !== null && lm.role === "assistant" && lm.kind === "message",
    msSinceActivity: mt === null ? null : nowMs - mt,
  });
}



/** A message is CONDITIONAL — delivered off the in-order cursor, tracked by id — when it is deferred
 *  or carries a notBefore. Everything else is IMMEDIATE and flows through the monotonic cursor. This
 *  split is what lets a future-dated watchdog (or a held defer) NOT head-of-line-block an immediate
 *  reply that arrives behind it. */
export function isConditional(msg: ChatMessage): boolean {
  return msg.defer || msg.notBefore !== null;
}

/** notBefore satisfied (or absent)? An unparseable timestamp is treated as due — never trap a message
 *  forever over a bad field. Pure: `nowMs` passed in. */
export function notBeforeDue(msg: ChatMessage, nowMs: number): boolean {
  if (msg.notBefore === null) return true;
  const t = Date.parse(msg.notBefore);
  return !Number.isFinite(t) || nowMs >= t;
}

/**
 * One push-delivery pass (called by the daemon on a fast cadence). For each chat-enabled, running
 * recipient it delivers at most ONE message, choosing between two tracks:
 *  - **Immediate track** — the monotonic `delivered` cursor over NON-conditional mail, in order.
 *    The cursor advances past non-recipient AND conditional messages, so conditional mail never
 *    blocks an immediate reply behind it (closes the head-of-line hole).
 *  - **Conditional track** — deferred / time-delayed (notBefore) mail, delivered BY ID when its
 *    condition holds (defer → target stably idle or already delivered by the Stop hook; notBefore →
 *    the instant has passed), regardless of ledger position. Dedup via the append-only ack-log —
 *    never the shared cursor, so the daemon stays the cursor's sole writer.
 * Invariants: never at a selection menu, never while a human is mid-keystroke (watching is fine),
 * one delivery per recipient per pass.
 * Cheap when idle: only recipients with something to deliver ever capture a pane.
 */
export async function deliverPending(m: MachineConfig): Promise<void> {
  const ledger = loadLedger(m);
  if (ledger.length === 0) return;
  const sessions = loadSessions(m);
  const running = await listSessionNames(m);
  const cursors = loadCursors(m);
  const acked = loadAckedIds(m); // conditional messages already injected (Stop hook or a prior pass)
  const now = Date.now();
  let changed = false;
  let deliveries = 0;

  for (const s of sessions) {
    if (deliveries >= MAX_PER_PASS) break;
    if (!chatEnabledFor(s, m) || !running.has(s.name)) continue;
    const provider = providerFor(s);
    const recipient = managedPeer(m.rcPrefix, s);
    const recipientKey = managedPeerKey(recipient);
    if (!provider.chatDeliverable) continue; // agent has no readiness detector → never inject (safe)

    // Track A: advance the cursor past non-recipient + conditional mail to the next IMMEDIATE to-me
    // message (conditional mail is Track B's; skipping it here is what prevents head-of-line blocking).
    const from = cursors.delivered[recipientKey] ?? 0;
    let immediate: { msg: ChatMessage; idx: number } | null = null;
    for (let i = from; i < ledger.length; i++) {
      const msg = ledger[i];
      if (!msg || msg.to.kind !== "managed" || managedPeerKey(msg.to) !== recipientKey) continue;
      if (isConditional(msg)) continue; // owned by Track B
      immediate = { msg, idx: i };
      break;
    }
    const cursorTo = immediate ? immediate.idx : ledger.length; // reach the immediate, or catch up
    if (cursors.delivered[recipientKey] !== cursorTo) {
      cursors.delivered[recipientKey] = cursorTo;
      changed = true;
    }

    // Track B (only when no immediate is pending): first time-eligible, un-delivered conditional.
    // defer-readiness needs the pane and is checked after capture, below.
    let conditional: { msg: ChatMessage; idx: number } | null = null;
    if (!immediate) {
      for (let i = 0; i < ledger.length; i++) {
        const msg = ledger[i];
        if (!msg || msg.to.kind !== "managed" || managedPeerKey(msg.to) !== recipientKey || !isConditional(msg)) continue;
        if (acked.has(msg.id) || !notBeforeDue(msg, now)) continue;
        conditional = { msg, idx: i };
        break;
      }
    }

    const pick = immediate ?? conditional;
    if (pick === null) continue; // nothing to deliver to s

    if (recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND) {
      log.warn({ msg: "chat rate limit — holding delivery (possible loop)", to: s.name });
      await writeChatHold(s.name, pick.msg.id, `rate limit — this recipient got more than ${RATE_MAX_INBOUND} messages in the last minute, delivery resumes as the burst subsides`);
      continue; // hold; retries once the burst subsides
    }
    // ONE capture, with attributes kept. `inputBusy` needs them to tell a human's typing from
    // Claude's dim autosuggestion; every other detector reads the stripped text.
    const styled = await capturePaneStyled(m, s.name, 40);
    const pane = stripAnsi(styled);
    if (!provider.chatDeliverable(pane)) {
      await writeChatHold(s.name, pick.msg.id, "recipient is at a selection menu — injecting would pick an option it never chose");
      continue;
    }
    // WATCHING a session must not block its chat — only actively TYPING does. Injection appends a
    // literal + Enter, so the sole hazard is a human's half-written line getting our text glued onto
    // it and sent. Two precise signals replace the old blunt "someone is attached" hold (which made
    // the channel look dead for as long as you kept the pane open): an occupied composer, or a
    // keystroke in the last few seconds (guards the gap between two keys).
    if (provider.inputBusy?.(styled) === true) {
      log.info({ msg: "chat delivery held — human is typing (composer not empty)", to: s.name, from: principalLabel(pick.msg.from) });
      await writeChatHold(s.name, pick.msg.id, "a human is typing in that pane right now");
      continue;
    }
    if (await clientTypingRecently(m, s.name, TYPING_WINDOW_SEC)) {
      log.info({ msg: "chat delivery held — human typed a moment ago", to: s.name, from: principalLabel(pick.msg.from) });
      await writeChatHold(s.name, pick.msg.id, "a human typed in that pane a moment ago");
      continue;
    }
    const ts = readTurnState(m, s, provider, pane, now);
    // "The UI has not painted yet" blocks EVERY track, not just deferred mail: delivery acks what it
    // types, so a keystroke swallowed by a half-drawn pane is a letter marked delivered and never
    // seen. Immediate and time-delayed mail were just as losable there.
    if (ts.why === "not-drawn") {
      await writeChatHold(s.name, pick.msg.id, WHY_TEXT[ts.why]);
      continue;
    }
    // A DEFERRED message additionally waits for the target to be between turns. A notBefore-only
    // message has no idle requirement — when due it delivers and the agent queues it.
    if (pick.msg.defer && !ts.settled) {
      // Name the gate that is actually unmet. One sentence for several gates is how the old note
      // ended up asserting "has not finished its turn" about a turn that was over.
      await writeChatHold(s.name, pick.msg.id, WHY_TEXT[ts.why]);
      continue;
    }

    // Re-read the ack for THIS id immediately before typing. The set loaded at the top of the pass is
    // a snapshot, and a Stop hook that fired since then has already injected this very message — the
    // window is narrow but it is a double-injection, not a lost letter, so it is worth one cheap read.
    if (isConditional(pick.msg) && loadAckedIds(m).has(pick.msg.id)) continue;

    if (!(await deliverToPane(m, s.name, pick.msg))) {
      // Nothing was typed (the session died mid-write). Acking here would bury the letter forever;
      // leaving it alone lets the next pass try again.
      log.warn({ msg: "chat delivery failed — target vanished mid-write, not acked", to: s.name });
      continue;
    }
    clearChatHold(s.name);
    if (isConditional(pick.msg)) {
      appendAck(m, pick.msg.id, "daemon", recipient); // off-cursor; dedup vs the Stop hook
    } else {
      cursors.delivered[recipientKey] = pick.idx + 1;
      // mark read so `ccmux inbox` won't re-show a pushed message
      cursors.read[recipientKey] = Math.max(cursors.read[recipientKey] ?? 0, pick.idx + 1);
    }
    changed = true;
    deliveries += 1;
    log.info({ msg: "chat delivered", from: principalLabel(pick.msg.from), to: s.name, conditional: isConditional(pick.msg) });
  }

  if (changed) await saveCursors(m, cursors);
}
