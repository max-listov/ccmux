import { type AgentProvider, type ChatPaneState, providerFor } from '../agent/index.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { loadSessions } from '../session/registry.ts';
import { type ChatHoldKind, clearChatHold, writeChatHold } from '../session/status.ts';
import {
  capturePaneStyled,
  clientTypingRecently,
  deletePasteBuffer,
  listSessionNames,
  loadPasteBuffer,
  setPaneInputEnabled,
  submitPasteBuffer,
  submittedChatId,
} from '../tmux/tmux.ts';
import type { ChatMessage, MachineConfig } from '../types.ts';
import { promptInvocation } from '../util/env.ts';
import { log } from '../util/log.ts';
import { appendAck, loadAckedIds } from './ackLog.ts';
import { coalesce } from './coalesce.ts';
import { loadCursors, saveCursors } from './cursors.ts';
import { deliverAppPending } from './deliverApp.ts';
import { formatChatInjection } from './format.ts';
import { managedPeer, managedPeerKey, principalLabel } from './identity.ts';
import { loadLedger } from './ledger.ts';
import { deliverNativeRuntimePending } from './nativeRuntime.ts';
import { RATE_MAX_INBOUND, recentInboundCount } from './rateGuard.ts';
import { replyRouteToSender } from './replyRoute.ts';
import { isConditional, nextDelivery } from './settlement.ts';
import {
  armPickup,
  chatTurnProgress,
  finishPickup,
  readTurnState,
  transcriptLineCount,
} from './turnProgress.ts';
import { WHY_TEXT } from './turnState.ts';

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
  // delivers with — never re-derived here from one transport's map, which is how a live remote route
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
        deliveries += await deliverNativeRuntimePending(
          m,
          s,
          ledger,
          cursors,
          acked,
          recentInboundCount(recipient, ledger, now) > RATE_MAX_INBOUND,
          now,
        );
      } catch (error) {
        // The hold itself is recorded by the deliverer, which already knows which letter the pass
        // was about; here the failure only reaches the log.
        log.warn({ msg: 'native managed chat held', name: s.name, error: String(error) });
      }
      continue;
    }
    if (!provider.inspectChatPane) continue; // agent has no readiness detector → never inject (safe)

    const activePickup = cursors.pickups[recipientKey];
    if (provider.chatPickup === 'transcript' && activePickup !== undefined) {
      const progress = chatTurnProgress(m, s, activePickup);
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
      await finishPickup(m, cursors, recipientKey, recipient);
      changed = false;
    }

    // Defer-readiness needs the pane and is checked after capture, below.
    const { pick, moved } = nextDelivery(ledger, recipientKey, cursors, acked, now);
    if (moved) changed = true;
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
      armPickup(cursors, recipientKey, pick, new Date(now).toISOString(), {
        transcriptLine: transcriptLineCount(m, s),
      });
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

  const app = await deliverAppPending(m, ledger, cursors, acked, now, MAX_PER_PASS - deliveries);
  deliveries += app.deliveries;
  changed ||= app.changed;

  if (changed) await saveCursors(m, cursors);
}
