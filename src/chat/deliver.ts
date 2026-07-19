import { loadSessions } from "../config/sessions.ts";
import { providerFor } from "../agent/index.ts";
import { capturePane, hasAttachedClient, listSessionNames, pasteText, sendKeysLiteral, sendKeysNamed } from "../tmux/tmux.ts";
import type { ChatMessage, MachineConfig } from "../types.ts";
import { log } from "../util/log.ts";
import { loadCursors, loadLedger, nextForRecipient, saveCursors } from "./store.ts";

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
 *  a PEER message, not the human. Bracketed paste keeps a multi-line body intact (no early submit);
 *  falls back to a newline-collapsed literal if the paste path fails. */
async function deliverToPane(m: MachineConfig, name: string, msg: ChatMessage): Promise<void> {
  const task = msg.task ? ` · task: ${msg.task}` : "";
  const text = `[chat from ${msg.from}${task}] ${msg.body}`;
  if (!(await pasteText(m, name, text))) {
    await sendKeysLiteral(m, name, text.replace(/\r?\n+/g, " ⏎ "));
  }
  await Bun.sleep(150); // let the paste/text land before the separate Enter
  await sendKeysNamed(m, name, "Enter");
}

/**
 * One push-delivery pass (called by the daemon on a fast cadence). For each chat-enabled, running
 * recipient: find its next undelivered message and, IF the pane is in a safe state, inject it —
 * else hold and retry next pass. Invariants:
 *  - **Never at a selection menu** (`provider.chatDeliverable` — injecting there picks an option).
 *  - **Never while a human is attached** (would interleave with their typing).
 *  - **One message per recipient per pass** — a natural throttle; delivering it flips the recipient
 *    to working, so the rest queue safely behind it (Claude queues typed input at turn boundaries).
 *  - **In order, no double-push** — the persistent `delivered` cursor advances past skipped
 *    non-recipient messages and survives daemon bounces.
 * Cheap when idle: only recipients with a pending message ever capture a pane.
 */
export async function deliverPending(m: MachineConfig): Promise<void> {
  const ledger = loadLedger(m);
  if (ledger.length === 0) return;
  const sessions = loadSessions(m);
  const running = await listSessionNames(m);
  const cursors = loadCursors(m);
  let changed = false;
  let deliveries = 0;

  for (const s of sessions) {
    if (deliveries >= MAX_PER_PASS) break;
    if (!s.chatEnabled || !running.has(s.name)) continue;
    const provider = providerFor(s);
    if (!provider.chatDeliverable) continue; // agent has no readiness detector → never inject (safe)

    const from = cursors.delivered[s.name] ?? 0;
    const next = nextForRecipient(s.name, ledger, from);
    if (next === null) {
      // caught up — record that everything so far is accounted for (skip non-recipient tail)
      if (from !== ledger.length) {
        cursors.delivered[s.name] = ledger.length;
        changed = true;
      }
      continue;
    }
    // advance past any non-recipient messages we skipped to reach `next` (they aren't ours)
    if (from !== next.idx) {
      cursors.delivered[s.name] = next.idx;
      changed = true;
    }
    if (recentInboundCount(s.name, ledger, Date.now()) > RATE_MAX_INBOUND) {
      log.warn({ msg: "chat rate limit — holding delivery (possible loop)", to: s.name });
      continue; // hold at next.idx; retries once the burst subsides
    }
    if (await hasAttachedClient(m, s.name)) continue; // a human is driving it — don't interleave
    const pane = await capturePane(m, s.name, 40);
    if (!provider.chatDeliverable(pane)) continue; // at a menu → hold, retry next pass

    await deliverToPane(m, s.name, next.msg);
    cursors.delivered[s.name] = next.idx + 1;
    // the message is now in the recipient's turn → also mark it read so `ccmux inbox` won't re-show it
    cursors.read[s.name] = Math.max(cursors.read[s.name] ?? 0, next.idx + 1);
    changed = true;
    deliveries += 1;
    log.info({ msg: "chat delivered", from: next.msg.from, to: s.name });
  }

  if (changed) await saveCursors(m, cursors);
}
