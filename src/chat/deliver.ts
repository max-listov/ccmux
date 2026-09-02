import { isOwnedCodex } from '../agent/codex/ownedPaths.ts';
import {
  type AgentProvider,
  type ChatPaneState,
  lastActivityMs,
  lastTranscriptMessage,
  providerFor,
  readTranscript,
} from '../agent/index.ts';
import {
  type ChatHoldKind,
  clearChatHold,
  readLifecycle,
  writeChatHold,
} from '../agent/sessionStatus.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadSessions } from '../config/sessions.ts';
import { promptInvocation } from '../env.ts';
import { lastSignOfLife } from '../events/observe.ts';
import { paneWorkingSince } from '../events/paneActivity.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';

import {
  capturePaneStyled,
  clientTypingRecently,
  deletePasteBuffer,
  listSessionNames,
  loadPasteBuffer,
  setPaneInputEnabled,
  stripAnsi,
  submitPasteBuffer,
  submittedChatId,
} from '../tmux/tmux.ts';
import type {
  ChatMessage,
  ChatTarget,
  MachineConfig,
  Session,
  TranscriptMessage,
} from '../types.ts';
import { log } from '../util/log.ts';
import { deliverCodexAppMessage } from './codexApp.ts';
import { formatChatInjection } from './format.ts';
import {
  chatTargetKey,
  managedPeer,
  managedPeerKey,
  principalLabel,
  targetLabel,
} from './identity.ts';
import { deliverNativeRuntimePending } from './nativeRuntime.ts';
import { deliverOwnedCodexPending } from './ownedCodex.ts';
import { replyRouteToSender } from './replyRoute.ts';
import {
  appendAck,
  type LedgerSlot,
  loadAckedIds,
  loadCursors,
  loadLedger,
  saveCursors,
} from './store.ts';
import { assistantEndedCurrentTurn, type TurnState, turnState, WHY_TEXT } from './turnState.ts';

/**
 * The pane state, as the kind a consumer reads. `deliverable` and `unknown` are not holds — the
 * first is not a refusal at all, and the second says the inspection could not tell, which is
 * exactly what `other` means here: the text is all there is.
 */
function holdKindOf(state: ChatPaneState): ChatHoldKind {
  return state === 'deliverable' || state === 'unknown' ? 'other' : state;
}

// Backstop against a runaway (e.g. an A→B→A loop): a single pass delivers at most this many
// messages fleet-wide. Combined with one-message-per-recipient-per-pass, chat can't flood a tick.
const MAX_PER_PASS = 20;

/**
 * How many waiting letters are handed over at once, and how much text that may be.
 *
 * Bounded because a session that was busy for an hour must not come back to a wall: the rest stay
 * queued and arrive at the next boundary, which is the same promise repeated rather than a new one.
 */
const MAX_BATCH = 8;
const MAX_BATCH_BYTES = 16_000;

// Loop/rate guard: hold delivery once a recipient has received more than this many messages within
// the rolling window. A runaway A→B→A ping-pong inflates BOTH sides' inbound rate → both pause →
// the loop breaks. Generous for a "phone call" channel; a genuine burst just spreads over time.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_INBOUND = 12;

/** Messages addressed to `name` sent within the window (by ledger `ts`). Pure — `nowMs` passed in. */
export function recentInboundCount(
  recipient: ChatTarget,
  ledger: readonly LedgerSlot[],
  nowMs: number,
): number {
  let n = 0;
  for (const msg of ledger) {
    if (msg === null || chatTargetKey(msg.to) !== chatTargetKey(recipient)) continue;
    const t = Date.parse(msg.ts);
    if (Number.isFinite(t) && nowMs - t <= RATE_WINDOW_MS) n += 1;
  }
  return n;
}

/** Inject a message into the recipient's pane as its next user turn, tagged so the agent knows it's
 *  a PEER message, not the human (shared framer — same tag the Stop hook uses). Bracketed paste keeps
 *  a multi-line body intact; pane input is gated across the final classification and submission. */
async function deliverToPane(
  m: MachineConfig,
  name: string,
  batch: readonly ChatMessage[],
  provider: AgentProvider,
  beforeSubmit: () => Promise<void>,
): Promise<{ submitted: boolean; hold: string | null; holdKind: ChatHoldKind }> {
  // Whether a reply would actually reach the sender is asked of the SAME resolver each message
  // delivers with — never re-derived here from one transport's map, which is how a live wire route
  // came to be announced as "no route back" while it was carrying mail.
  //
  // Several letters that waited out one turn arrive as ONE turn. Two peers writing to a busy session
  // used to produce two injections, and the second landed inside the turn the first had just
  // started — the recipient was interrupted by its own mail. Each keeps its own header, so who wrote
  // what and how to answer each of them is unchanged; only the number of turns is.
  const text = batch
    .map((msg) =>
      formatChatInjection(msg, {
        cli: promptInvocation(),
        reply: replyRouteToSender(m, msg.from),
      }),
    )
    .join('\n\n');
  const buffer = await loadPasteBuffer(m, text);
  if (buffer === null) return { submitted: false, hold: null, holdKind: 'other' };
  let inputDisabled = false;
  try {
    inputDisabled = await setPaneInputEnabled(m, name, false);
    if (!inputDisabled) return { submitted: false, hold: null, holdKind: 'other' };
    // This is the authoritative sample: client input is already gated and cannot change the
    // composer between classification and the paste+Enter command queue.
    const inspection = provider.inspectChatPane?.(await capturePaneStyled(m, name, 40));
    if (inspection === undefined || inspection.state !== 'deliverable') {
      return {
        submitted: false,
        hold: inspection?.reason ?? 'this provider cannot receive managed chat',
        // No inspection at all is not an unknown pane state — it is a provider that cannot take
        // managed chat, and calling that `other` would hide a permanent refusal among transient
        // ones. It has no pane kind, so it keeps the text and says the text is all there is.
        holdKind: inspection === undefined ? 'other' : holdKindOf(inspection.state),
      };
    }
    await beforeSubmit();
    // The first letter's id is the submission's identity: it is the one the pickup proof and the
    // hold record are keyed on, and a batch is delivered or not delivered as a whole.
    const submitted = await submitPasteBuffer(m, name, buffer, batch[0]?.id ?? name);
    if (submitted) inputDisabled = false; // submit's first queued command re-enabled the pane
    return { submitted, hold: null, holdKind: 'other' };
  } finally {
    if (inputDisabled) await setPaneInputEnabled(m, name, true);
    await deletePasteBuffer(m, buffer);
  }
}

// The Stop hook delivers a deferred message the instant a turn ends; this daemon path is the
// backbone for a target that was ALREADY between turns when the message arrived — including one
// whose turn was killed, for which no Stop is ever coming (see `turnState`).
// How recently a keystroke means "still typing" — long enough to bridge the gap between two keys,
// short enough that simply watching a pane never blocks delivery.
const TYPING_WINDOW_SEC = 3;

/**
 * Gather what `turnState` needs from this session's pane and transcript. The IO lives here so the
 * decision itself stays pure and testable — the previous version was neither, which is how it
 * shipped waiting on an event that a killed turn can never produce.
 *
 * Silence is the evidence a turn is over, and the transcript is only half of what silence means. A
 * session four minutes into a tool call writes nothing while its pane is plainly working, so the
 * supervisor's record of when each pane was last seen working counts as activity beside the
 * transcript's own mtime. Without it, one look at the pane in the gap between a tool finishing and
 * its result being written reads as a turn nobody is coming back to — and `ccmux wait`, which is a
 * fresh process with no memory of its own, would answer "done" about a session mid-work.
 */
export function readTurnState(
  m: MachineConfig,
  s: Session,
  provider: AgentProvider,
  pane: string,
  nowMs: number,
  injected?: { turnStartedMs: number; assistantAnswered: boolean },
): TurnState {
  const plain = stripAnsi(pane);
  const scan = provider.scanPane(plain);
  const inspection = provider.inspectChatPane?.(pane);
  const lm = lastTranscriptMessage(s, m);
  const activity = lastActivityMs(s, m);
  const lifecycle = readLifecycle(s.name);
  const turnStartedMs =
    injected?.turnStartedMs ?? (lifecycle?.state === 'working' ? lifecycle.ts : null);
  const mt = lastSignOfLife(
    activity,
    scan.state === 'working' ? nowMs : paneWorkingSince(m, s.name),
    turnStartedMs,
  );
  return turnState({
    paneWorking: scan.state === 'working',
    // `ready` is a HARD gate here, so it may only be trusted from a provider whose pane detectors are
    // calibrated. `chatDeliverable` is that marker: an agent that can say "this pane is safe to type
    // into" has had its chrome mapped; one that cannot has not. Treating an unreliable "not drawn" as
    // a permanent block would recreate the very hang this change removes, on another agent.
    paneReady: provider.inspectChatPane === undefined ? true : scan.ready,
    atMenu: scan.atPrompt !== null,
    paneBlock:
      inspection?.state === 'input-busy'
        ? 'input-occupied'
        : inspection?.state === 'unknown'
          ? 'unknown-pane'
          : null,
    endedOnAssistantText:
      injected?.assistantAnswered ?? assistantEndedCurrentTurn(lm, activity, turnStartedMs),
    msSinceActivity: mt === null ? null : nowMs - mt,
  });
}

export type ChatTurnProgress = 'awaiting-pickup' | 'running' | 'answered' | 'interrupted';

export function chatTurnProgressFromMessages(
  messages: readonly TranscriptMessage[],
  messageId: string,
): ChatTurnProgress {
  const marker = `id: ${messageId}`;
  let pickedUp = false;
  let lastAfterPickup: TranscriptMessage | null = null;
  for (const message of messages) {
    if (
      !pickedUp &&
      message.role === 'user' &&
      message.kind === 'message' &&
      message.text?.includes(marker) === true
    ) {
      pickedUp = true;
      continue;
    }
    if (pickedUp) lastAfterPickup = message;
  }
  if (!pickedUp) return 'awaiting-pickup';
  if (
    lastAfterPickup?.role === 'system' &&
    lastAfterPickup.text?.includes('<turn_aborted>') === true
  )
    return 'interrupted';
  return lastAfterPickup?.role === 'assistant' && lastAfterPickup.kind === 'message'
    ? 'answered'
    : 'running';
}

/** Provider-neutral normalized transcript proof for a pane-injected turn. Full history is read
 * because a tool-heavy turn may put thousands of records between the exact user marker and answer. */
export function chatTurnProgress(
  m: MachineConfig,
  s: Session,
  messageId: string,
): ChatTurnProgress {
  const messages = readTranscript(s, m, { tail: Number.MAX_SAFE_INTEGER }).messages;
  return chatTurnProgressFromMessages(messages, messageId);
}

/** Persisted pre-submit transition. Cursor and pickup move in one atomic cursors-file write. */
export function armTranscriptPickup(
  cursors: ReturnType<typeof loadCursors>,
  recipientKey: string,
  pick: { msg: ChatMessage; idx: number },
  injectedAt: string,
): void {
  const conditional = isConditional(pick.msg);
  cursors.pickups[recipientKey] = {
    messageId: pick.msg.id,
    injectedAt,
    ledgerIndex: pick.idx,
    conditional,
  };
  if (!conditional) {
    cursors.delivered[recipientKey] = pick.idx + 1;
    cursors.read[recipientKey] = Math.max(cursors.read[recipientKey] ?? 0, pick.idx + 1);
  }
}

/**
 * A letter an application says a person wrote.
 *
 * An attested claim, not an authenticated identity — the ingress attests the author category and
 * nothing here has verified the human. That is enough for THIS use and for no other: it decides
 * which letter keeps its place in a full batch, which grants no authority and cannot be abused into
 * any. Deciding it by principal was the trap: `cli` means "a person or an agent at a shell" by its
 * own definition, so preferring it would prefer half the agent traffic.
 */
const fromPerson = (msg: ChatMessage): boolean => msg.origin?.actor === 'human';

/**
 * Every letter now waiting for this recipient's boundary, in the order they were written.
 *
 * The first one is what the gates above were decided on; these are the others that would otherwise
 * each cost the recipient a separate turn — and the second of them would land INSIDE the turn the
 * first had just started, which is the interruption this whole path exists to avoid.
 *
 * The batch is bounded, so something has to be the letter that does not fit, and by arrival time
 * alone that was whatever came last — a person writing to a session with a dozen queued peer
 * letters waited a whole extra turn behind chatter. So the bound cuts agent letters first: what is
 * SELECTED is ordered person-first, and what is SENT is put back in the order it was written,
 * because a conversation read out of order is worse than a letter arriving a turn late.
 *
 * The oldest waiting letter always travels, whoever wrote it. It is the one the delivery gates were
 * decided on above, and a letter that keeps losing its place to newer ones is the starvation this
 * whole queue exists to avoid.
 */
export function coalesce(
  ledger: readonly LedgerSlot[],
  recipientKey: string,
  acked: ReadonlySet<string>,
  now: number,
): ChatMessage[] {
  const waiting: ChatMessage[] = [];
  for (const msg of ledger) {
    if (msg === null || msg.to.kind !== 'managed' || managedPeerKey(msg.to) !== recipientKey)
      continue;
    if (!isConditional(msg) || acked.has(msg.id) || !notBeforeDue(msg, now)) continue;
    waiting.push(msg);
  }
  const [oldest, ...rest] = waiting;
  if (oldest === undefined) return [];
  const selected = new Set<string>();
  let bytes = 0;
  for (const msg of [oldest, ...rest.filter(fromPerson), ...rest.filter((m) => !fromPerson(m))]) {
    bytes += Buffer.byteLength(msg.body);
    if (selected.size >= MAX_BATCH || (selected.size > 0 && bytes > MAX_BATCH_BYTES)) break;
    selected.add(msg.id);
  }
  return waiting.filter((msg) => selected.has(msg.id));
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
    if (hasNativeRuntime(s)) {
      try {
        const deliver = isOwnedCodex(s) ? deliverOwnedCodexPending : deliverNativeRuntimePending;
        deliveries += await deliver(
          m,
          s,
          ledger,
          cursors,
          acked,
          recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND,
          now,
        );
      } catch (error) {
        log.warn({ msg: 'native managed chat held', name: s.name, error: String(error) });
      }
      continue;
    }
    if (!provider.inspectChatPane) continue; // agent has no readiness detector → never inject (safe)

    const activePickup = cursors.pickups[recipientKey];
    if (provider.chatPickup === 'transcript' && activePickup !== undefined) {
      const progress = chatTurnProgress(m, s, activePickup.messageId);
      if (progress !== 'answered' && progress !== 'interrupted') {
        // The intent is durable before Enter. A restart in that window must not select a second
        // ledger item or immediately paste this one twice. If Enter never happened, a structurally
        // idle pane may retry only after the transcript has had a bounded chance to expose pickup.
        if (
          progress === 'running' ||
          (await submittedChatId(m, s.name)) === activePickup.messageId ||
          now - Date.parse(activePickup.injectedAt) < 15_000
        )
          continue;
        const activeMessage = ledger.find((slot) => slot?.id === activePickup.messageId);
        if (activeMessage === null || activeMessage === undefined) continue;
        const retry = await deliverToPane(m, s.name, [activeMessage], provider, async () => {});
        if (!retry.submitted) {
          if (retry.hold !== null)
            await writeChatHold(s.name, activeMessage.id, retry.hold, retry.holdKind);
          continue;
        }
        clearChatHold(s.name);
        deliveries += 1;
        continue;
      }
      const pickupPane = await capturePaneStyled(m, s.name, 40);
      const pickupTurn = readTurnState(m, s, provider, pickupPane, now, {
        turnStartedMs: Date.parse(activePickup.injectedAt),
        assistantAnswered: true,
      });
      if (!pickupTurn.settled) continue;
      if (activePickup.conditional) appendAck(m, activePickup.messageId, 'daemon', recipient);
      else if (activePickup.ledgerIndex !== null) {
        cursors.delivered[recipientKey] = Math.max(
          cursors.delivered[recipientKey] ?? 0,
          activePickup.ledgerIndex + 1,
        );
        cursors.read[recipientKey] = Math.max(
          cursors.read[recipientKey] ?? 0,
          activePickup.ledgerIndex + 1,
        );
      }
      const { [recipientKey]: _completed, ...remaining } = cursors.pickups;
      cursors.pickups = remaining;
      await saveCursors(m, cursors);
      changed = false;
    }

    // Track A: advance the cursor past non-recipient + conditional mail to the next IMMEDIATE to-me
    // message (conditional mail is Track B's; skipping it here is what prevents head-of-line blocking).
    const from = cursors.delivered[recipientKey] ?? 0;
    let immediate: { msg: ChatMessage; idx: number } | null = null;
    for (let i = from; i < ledger.length; i++) {
      const msg = ledger[i];
      if (msg?.to.kind !== 'managed' || managedPeerKey(msg.to) !== recipientKey) continue;
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
        if (
          msg?.to.kind !== 'managed' ||
          managedPeerKey(msg.to) !== recipientKey ||
          !isConditional(msg)
        )
          continue;
        if (acked.has(msg.id) || !notBeforeDue(msg, now)) continue;
        conditional = { msg, idx: i };
        break;
      }
    }

    const pick = immediate ?? conditional;
    if (pick === null) continue; // nothing to deliver to s

    if (recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND) {
      log.warn({ msg: 'chat rate limit — holding delivery (possible loop)', to: s.name });
      await writeChatHold(
        s.name,
        pick.msg.id,
        `rate limit — this recipient got more than ${RATE_MAX_INBOUND} messages in the last minute, delivery resumes as the burst subsides`,
        'rate-limited',
      );
      continue; // hold; retries once the burst subsides
    }
    // ONE capture, with attributes kept. `inputBusy` needs them to tell a human's typing from
    // Claude's dim autosuggestion; every other detector reads the stripped text.
    const styled = await capturePaneStyled(m, s.name, 40);
    const inspection = provider.inspectChatPane(styled);
    if (inspection.state !== 'deliverable') {
      await writeChatHold(s.name, pick.msg.id, inspection.reason, holdKindOf(inspection.state));
      continue;
    }
    // WATCHING a session must not block its chat — only actively TYPING does. Injection appends a
    // literal + Enter, so the sole hazard is a human's half-written line getting our text glued onto
    // it and sent. Two precise signals replace the old blunt "someone is attached" hold (which made
    // the channel look dead for as long as you kept the pane open): an occupied composer, or a
    // keystroke in the last few seconds (guards the gap between two keys).
    if (await clientTypingRecently(m, s.name, TYPING_WINDOW_SEC)) {
      log.info({
        msg: 'chat delivery held — human typed a moment ago',
        to: s.name,
        from: principalLabel(pick.msg.from),
      });
      await writeChatHold(
        s.name,
        pick.msg.id,
        'a human typed in that pane a moment ago',
        'human-typing',
      );
      continue;
    }
    const ts = readTurnState(m, s, provider, styled, now);
    // "The UI has not painted yet" blocks EVERY track, not just deferred mail: delivery acks what it
    // types, so a keystroke swallowed by a half-drawn pane is a letter marked delivered and never
    // seen. Immediate and time-delayed mail were just as losable there.
    if (ts.why === 'not-drawn') {
      await writeChatHold(s.name, pick.msg.id, WHY_TEXT[ts.why], 'not-drawn');
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

    const transcriptPickup = provider.chatPickup === 'transcript';
    // Everything else that has been waiting for this same boundary travels with it. Not on the
    // transcript-pickup path: there delivery is proved by one message id appearing in the
    // transcript, and a batch has no single id to prove.
    const batch =
      isConditional(pick.msg) && !transcriptPickup
        ? coalesce(ledger, recipientKey, acked, now)
        : [pick.msg];
    const delivery = await deliverToPane(m, s.name, batch, provider, async () => {
      if (!transcriptPickup) return;
      armTranscriptPickup(cursors, recipientKey, pick, new Date(now).toISOString());
      await saveCursors(m, cursors);
    });
    if (delivery.hold !== null) {
      await writeChatHold(s.name, pick.msg.id, delivery.hold);
      continue;
    }
    if (!delivery.submitted) {
      // Nothing was typed (the session died mid-write). Acking here would bury the letter forever;
      // leaving it alone lets the next pass try again.
      log.warn({ msg: 'chat delivery failed — target vanished mid-write, not acked', to: s.name });
      continue;
    }
    clearChatHold(s.name);
    if (transcriptPickup) {
      // Cursor + exact barrier were persisted together before the atomic pane submission. Completion
      // clears the barrier only after transcript answer + structural settle.
    } else if (isConditional(pick.msg)) {
      // Every letter in the batch was typed, so every one of them is acked. Acking only the first
      // would deliver the rest a second time on the next pass.
      for (const msg of batch) appendAck(m, msg.id, 'daemon', recipient); // dedup vs the Stop hook
    } else {
      cursors.delivered[recipientKey] = pick.idx + 1;
      // mark read so `ccmux inbox` won't re-show a pushed message
      cursors.read[recipientKey] = Math.max(cursors.read[recipientKey] ?? 0, pick.idx + 1);
    }
    changed = true;
    deliveries += 1;
    log.info({
      msg: 'chat delivered',
      from: principalLabel(pick.msg.from),
      to: s.name,
      conditional: isConditional(pick.msg),
    });
  }

  // App threads are ledger peers but not tmux sessions. The shared App Server is their only writer
  // boundary; delivery uses the immutable client message id as its crash-safe pickup proof.
  const appRecipients = new Map<string, Extract<ChatTarget, { kind: 'codex-app' }>>();
  for (const slot of ledger) {
    if (slot?.to.kind !== 'codex-app' || slot.to.machine !== m.rcPrefix) continue;
    appRecipients.set(chatTargetKey(slot.to), slot.to);
  }
  for (const [recipientKey, recipient] of appRecipients) {
    if (deliveries >= MAX_PER_PASS) break;
    const activePickup = cursors.pickups[recipientKey];
    if (activePickup !== undefined) {
      const activeMessage = ledger.find((slot) => slot?.id === activePickup.messageId);
      if (activeMessage === null || activeMessage === undefined) continue;
      try {
        const text = formatChatInjection(activeMessage, {
          cli: promptInvocation(),
          reply: replyRouteToSender(m, activeMessage.from),
        });
        const result = await deliverCodexAppMessage(m, activeMessage, text);
        if (!result.delivered) {
          log.info({
            msg: 'Codex App chat pickup held',
            to: targetLabel(recipient),
            reason: result.reason,
          });
          continue;
        }
        if (activePickup.conditional) appendAck(m, activePickup.messageId, 'daemon', recipient);
        const { [recipientKey]: _completed, ...remaining } = cursors.pickups;
        cursors.pickups = remaining;
        await saveCursors(m, cursors);
        deliveries += 1;
        log.info({
          msg: 'Codex App chat pickup completed',
          to: targetLabel(recipient),
          duplicate: result.duplicate,
        });
      } catch (error) {
        log.warn({
          msg: 'Codex App chat pickup unavailable — barrier retained',
          to: targetLabel(recipient),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    const from = cursors.delivered[recipientKey] ?? 0;
    let immediate: { msg: ChatMessage; idx: number } | null = null;
    for (let i = from; i < ledger.length; i++) {
      const msg = ledger[i];
      if (!msg || chatTargetKey(msg.to) !== recipientKey || isConditional(msg)) continue;
      immediate = { msg, idx: i };
      break;
    }
    const cursorTo = immediate ? immediate.idx : ledger.length;
    if (cursors.delivered[recipientKey] !== cursorTo) {
      cursors.delivered[recipientKey] = cursorTo;
      changed = true;
    }
    let conditional: { msg: ChatMessage; idx: number } | null = null;
    if (!immediate) {
      for (let i = 0; i < ledger.length; i++) {
        const msg = ledger[i];
        if (!msg || chatTargetKey(msg.to) !== recipientKey || !isConditional(msg)) continue;
        if (acked.has(msg.id) || !notBeforeDue(msg, now)) continue;
        conditional = { msg, idx: i };
        break;
      }
    }
    const pick = immediate ?? conditional;
    if (pick === null) continue;
    if (recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND) {
      log.warn({
        msg: 'chat rate limit — holding App delivery (possible loop)',
        to: targetLabel(recipient),
      });
      continue;
    }
    if (isConditional(pick.msg) && loadAckedIds(m).has(pick.msg.id)) continue;
    try {
      const text = formatChatInjection(pick.msg, {
        cli: promptInvocation(),
        reply: replyRouteToSender(m, pick.msg.from),
      });
      armTranscriptPickup(cursors, recipientKey, pick, new Date(now).toISOString());
      await saveCursors(m, cursors);
      // This barrier was created in this process immediately before the first submission, so there
      // is no prior accepted turn to scan for. A restarted process takes the activePickup path above
      // and performs the persisted client-id proof before it retries.
      const result = await deliverCodexAppMessage(m, pick.msg, text, undefined, async () => false);
      if (!result.delivered) {
        log.info({
          msg: 'Codex App chat delivery held',
          to: targetLabel(recipient),
          from: principalLabel(pick.msg.from),
          reason: result.reason,
        });
        continue;
      }
      if (isConditional(pick.msg)) appendAck(m, pick.msg.id, 'daemon', recipient);
      const { [recipientKey]: _completed, ...remaining } = cursors.pickups;
      cursors.pickups = remaining;
      changed = true;
      deliveries += 1;
      log.info({
        msg: 'chat delivered to Codex App',
        from: principalLabel(pick.msg.from),
        to: targetLabel(recipient),
        duplicate: result.duplicate,
      });
    } catch (error) {
      log.warn({
        msg: 'Codex App chat delivery unavailable — not acked',
        to: targetLabel(recipient),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (changed) await saveCursors(m, cursors);
}
