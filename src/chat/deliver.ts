import { loadSessions } from "../config/sessions.ts";
import { providerFor, lastTranscriptMessage, lastActivityMs, type AgentProvider } from "../agent/index.ts";
import { capturePane, hasAttachedClient, listSessionNames, pasteText, sendKeysLiteral, sendKeysNamed } from "../tmux/tmux.ts";
import type { ChatMessage, MachineConfig, Session } from "../types.ts";
import { log } from "../util/log.ts";
import { formatChatInjection } from "./format.ts";
import { appendAck, loadAckedIds, loadCursors, loadLedger, saveCursors } from "./store.ts";

// Backstop against a runaway (e.g. an A→B→A loop): a single pass delivers at most this many
// messages fleet-wide. Combined with one-message-per-recipient-per-pass, chat can't flood a tick.
const MAX_PER_PASS = 20;

// Loop/rate guard: hold delivery once a recipient has received more than this many messages within
// the rolling window. A runaway A→B→A ping-pong inflates BOTH sides' inbound rate → both pause →
// the loop breaks. Generous for a "phone call" channel; a genuine burst just spreads over time.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_INBOUND = 12;

/** Messages addressed to `name` sent within the window (by ledger `ts`). Pure — `nowMs` passed in. */
export function recentInboundCount(name: string, ledger: ChatMessage[], nowMs: number): number {
  let n = 0;
  for (const msg of ledger) {
    if (msg.to !== name) continue;
    const t = Date.parse(msg.ts);
    if (Number.isFinite(t) && nowMs - t <= RATE_WINDOW_MS) n += 1;
  }
  return n;
}

/** Inject a message into the recipient's pane as its next user turn, tagged so the agent knows it's
 *  a PEER message, not the human (shared framer — same tag the Stop hook uses). Bracketed paste keeps
 *  a multi-line body intact (no early submit); falls back to a newline-collapsed literal on failure. */
async function deliverToPane(m: MachineConfig, name: string, msg: ChatMessage): Promise<void> {
  const text = formatChatInjection(msg);
  if (!(await pasteText(m, name, text))) {
    await sendKeysLiteral(m, name, text.replace(/\r?\n+/g, " ⏎ "));
  }
  await Bun.sleep(150); // let the paste/text land before the separate Enter
  await sendKeysNamed(m, name, "Enter");
}

// A DEFERRED message is delivered by the daemon ONLY when the target has VOLUNTARILY finished and
// gone STABLY idle — never mid-turn. The Stop hook (Phase 2) delivers a mid-turn defer the instant
// the turn ends; this daemon path is the backbone for a target that was ALREADY idle when the
// message arrived (no Stop is coming for it).
const DEFER_GRACE_MS = 6_000;

/** Is a deferred message safe to deliver to this target right now? Three conditions, all required:
 *   - not actively working (pane spinner off);
 *   - sitting at an assistant MESSAGE — the turn ended on text, not mid-tool (status.ts `waiting`);
 *   - STABLE: the transcript hasn't moved for DEFER_GRACE_MS. This rules out the brief mid-turn gap
 *     between an assistant text line and the following tool_use line (proven real — a turn is split
 *     into separate thinking/text/tool_use JSONL lines, so `assistant-message-last` occurs mid-turn).
 *  Menu-safety + human-attached are checked separately by the caller. */
function deferReady(m: MachineConfig, s: Session, provider: AgentProvider, pane: string, nowMs: number): boolean {
  if (provider.scanPane(pane).state === "working") return false;
  const lm = lastTranscriptMessage(s, m);
  if (!(lm && lm.role === "assistant" && lm.kind === "message")) return false;
  const mt = lastActivityMs(s, m);
  return mt !== null && nowMs - mt >= DEFER_GRACE_MS;
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
 * Invariants unchanged: never at a selection menu, never while a human is attached, one per pass.
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
    if (!s.chatEnabled || !running.has(s.name)) continue;
    const provider = providerFor(s);
    if (!provider.chatDeliverable) continue; // agent has no readiness detector → never inject (safe)

    // Track A: advance the cursor past non-recipient + conditional mail to the next IMMEDIATE to-me
    // message (conditional mail is Track B's; skipping it here is what prevents head-of-line blocking).
    const from = cursors.delivered[s.name] ?? 0;
    let immediate: { msg: ChatMessage; idx: number } | null = null;
    for (let i = from; i < ledger.length; i++) {
      const msg = ledger[i];
      if (!msg || msg.to !== s.name) continue;
      if (isConditional(msg)) continue; // owned by Track B
      immediate = { msg, idx: i };
      break;
    }
    const cursorTo = immediate ? immediate.idx : ledger.length; // reach the immediate, or catch up
    if (cursors.delivered[s.name] !== cursorTo) {
      cursors.delivered[s.name] = cursorTo;
      changed = true;
    }

    // Track B (only when no immediate is pending): first time-eligible, un-delivered conditional.
    // defer-readiness needs the pane and is checked after capture, below.
    let conditional: { msg: ChatMessage; idx: number } | null = null;
    if (!immediate) {
      for (let i = 0; i < ledger.length; i++) {
        const msg = ledger[i];
        if (!msg || msg.to !== s.name || !isConditional(msg)) continue;
        if (acked.has(msg.id) || !notBeforeDue(msg, now)) continue;
        conditional = { msg, idx: i };
        break;
      }
    }

    const pick = immediate ?? conditional;
    if (pick === null) continue; // nothing to deliver to s

    if (recentInboundCount(s.name, ledger, now) > RATE_MAX_INBOUND) {
      log.warn({ msg: "chat rate limit — holding delivery (possible loop)", to: s.name });
      continue; // hold; retries once the burst subsides
    }
    if (await hasAttachedClient(m, s.name)) continue; // a human is driving it — don't interleave
    const pane = await capturePane(m, s.name, 40);
    if (!provider.chatDeliverable(pane)) continue; // at a menu → hold, retry next pass
    // A DEFERRED message additionally waits for the target to be STABLY idle (voluntarily finished).
    // A notBefore-only message has no idle requirement — when due it delivers and Claude queues it.
    if (pick.msg.defer && !deferReady(m, s, provider, pane, now)) continue;

    await deliverToPane(m, s.name, pick.msg);
    if (isConditional(pick.msg)) {
      appendAck(m, pick.msg.id, "daemon", s.name); // off-cursor; dedup vs the Stop hook
    } else {
      cursors.delivered[s.name] = pick.idx + 1;
      // mark read so `ccmux inbox` won't re-show a pushed message
      cursors.read[s.name] = Math.max(cursors.read[s.name] ?? 0, pick.idx + 1);
    }
    changed = true;
    deliveries += 1;
    log.info({ msg: "chat delivered", from: pick.msg.from, to: s.name, conditional: isConditional(pick.msg) });
  }

  if (changed) await saveCursors(m, cursors);
}
