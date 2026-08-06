import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ChatCursorsSchema, ChatMessageSchema } from "../config/schema.ts";
import type { ChatCursors, ChatMessage, MachineConfig } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import { chatAckPath, chatCursorsPath, chatLedgerPath } from "../config/paths.ts";

/** Reserved chat recipient = the human who runs the fleet. A message TO `owner` is NOT delivered
 *  to any pane (the owner has none) — it only surfaces out-of-band (Telegram, and later a frontend).
 *  A message FROM `owner` is the human, not a peer agent. Not a session name; can't collide because
 *  delivery only ever targets real sessions. */
export const OWNER = "owner";

/** Reserved SENDER = the command-line operator (a human or Claude driving `ccmux msg` from a shell) —
 *  NOT a managed session, NOT the owner. It's the default `from` for a command-line send, so those
 *  read as `cli → …` (and never masquerade as the owner). Not a delivery target. */
export const CLI = "cli";

/**
 * Inter-agent chat storage — an append-only ledger (source of truth) + a small cursors file. Both
 * live in the instance's state directory, so a config built for a test gives that test its own
 * chat store, and a machine keeps exactly one store beside its one registry.
 */
export function chatPaths(m: MachineConfig): { ledger: string; cursors: string } {
  return { ledger: chatLedgerPath(m), cursors: chatCursorsPath(m) };
}

// The defer-delivery ack-log (`chatAckPath`) is an append-only record of which DEFER messages have
// been injected, keyed by message id. It is how the Stop hook and the daemon coordinate WITHOUT
// sharing a mutable cursor (which would lose-update — see the design doc's R5): each appends one
// O_APPEND line (atomic across processes, like the ledger), and both check it before delivering, so
// a message is injected exactly once. The daemon stays the SOLE writer of `cursors`; the hook only
// ever touches the ack-log.

/** Set of message ids already delivered (defer channel). Lenient: a corrupt line is skipped, not
 *  thrown — the hook must never wedge a session's ability to stop over a bad ack line. */
export function loadAckedIds(m: MachineConfig): Set<string> {
  const p = chatAckPath(m);
  const ids = new Set<string>();
  if (!existsSync(p)) return ids;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const o: unknown = JSON.parse(line);
      if (o && typeof o === "object" && "id" in o && typeof o.id === "string") ids.add(o.id);
    } catch {
      // skip — best-effort dedup log, not authoritative history
    }
  }
  return ids;
}

/** Record a conditional-message resolution in the ack-log. `by`:
 *   - `hook`/`daemon` — DELIVERED (injected into the pane by that process);
 *   - `cancel`        — CANCELLED before delivery (`msg cancel`, or replaced by a re-armed watchdog).
 * All three suppress future delivery identically (both the daemon and the Stop hook skip any id in
 * this log), so a cancel is just a delivery that will never happen — the honest `by` keeps the log
 * readable. O_APPEND single-line write is atomic across the hook + daemon + sender processes. */
export function appendAck(m: MachineConfig, id: string, by: "hook" | "daemon" | "cancel", to: string): void {
  appendFileSync(chatAckPath(m), `${JSON.stringify({ id, ts: new Date().toISOString(), by, to })}\n`);
}

/** Undelivered CONDITIONAL messages (deferred or time-delayed), optionally filtered by sender /
 *  recipient / task. "Undelivered" = not yet in the ack-log (neither delivered nor already
 *  cancelled). This is the set `msg cancel` tombstones and the set a re-armed `--task` replaces.
 *  notBefore due-ness is intentionally NOT considered — a future-dated watchdog is still pending. */
export function pendingConditional(
  ledger: ChatMessage[],
  acked: Set<string>,
  filter: { from?: string; to?: string; task?: string },
): ChatMessage[] {
  return ledger.filter((msg) => {
    if (!(msg.defer || msg.notBefore !== null)) return false; // immediate mail is delivered at once
    if (acked.has(msg.id)) return false; // already delivered or cancelled
    if (filter.from !== undefined && msg.from !== filter.from) return false;
    if (filter.to !== undefined && msg.to !== filter.to) return false;
    if (filter.task !== undefined && msg.task !== filter.task) return false;
    return true;
  });
}

/** Read + validate the whole ledger in order. A corrupt line fails LOUD with its number — the
 *  append-only history is never silently dropped. */
export function loadLedger(m: MachineConfig): ChatMessage[] {
  const { ledger } = chatPaths(m);
  if (!existsSync(ledger)) return [];
  const out: ChatMessage[] = [];
  const lines = readFileSync(ledger, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`chat ledger:${i + 1} — invalid JSON`);
    }
    out.push(ChatMessageSchema.parse(raw));
  }
  return out;
}

/** Append one message. O_APPEND (flag "a") makes a single line write atomic across concurrent
 *  senders — no read-modify-write race, no interleave. The ledger is never rewritten. */
export function appendMessage(m: MachineConfig, msg: ChatMessage): void {
  const { ledger } = chatPaths(m);
  const parsed = ChatMessageSchema.parse(msg);
  appendFileSync(ledger, `${JSON.stringify(parsed)}\n`);
}

/** Read the cursors. Corrupt/missing → empty (cursors are derived state, not history — safe to
 *  reset; the ledger is untouched). */
export function loadCursors(m: MachineConfig): ChatCursors {
  const { cursors } = chatPaths(m);
  if (!existsSync(cursors)) return ChatCursorsSchema.parse({});
  try {
    return ChatCursorsSchema.parse(JSON.parse(readFileSync(cursors, "utf8")));
  } catch {
    return ChatCursorsSchema.parse({});
  }
}

/** Persist the cursors atomically (single small JSON; the daemon is the intended sole writer). */
export async function saveCursors(m: MachineConfig, c: ChatCursors): Promise<void> {
  const { cursors } = chatPaths(m);
  await atomicWrite(cursors, `${JSON.stringify(c, null, 2)}\n`);
}

/**
 * Unread inbox for a recipient: messages addressed TO it at/after its read cursor.
 *
 * `acked` closes a real hole: CONDITIONAL mail (defer / notBefore) is delivered OFF the cursor and
 * recorded only in the ack-log, so the read cursor never advances past it. Without consulting the
 * ack-log, an already-injected deferred message stayed in `inbox` forever — contradicting the
 * documented contract ("a message already pushed to the pane isn't here") and making any
 * "why hasn't this been delivered" answer lie about mail that HAS been delivered.
 */
export function unreadFor(
  name: string,
  ledger: ChatMessage[],
  cursors: ChatCursors,
  acked?: ReadonlySet<string>,
): { msg: ChatMessage; idx: number }[] {
  const since = cursors.read[name] ?? 0;
  const out: { msg: ChatMessage; idx: number }[] = [];
  for (let idx = since; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (!msg || msg.to !== name) continue;
    if (acked?.has(msg.id) === true) continue; // already injected (Stop hook or daemon) — not pending
    out.push({ msg, idx });
  }
  return out;
}

/** Advance a recipient's read cursor to the whole-ledger length (everything up to now seen). */
export async function markRead(m: MachineConfig, name: string, ledgerLen: number): Promise<void> {
  const c = loadCursors(m);
  await saveCursors(m, { ...c, read: { ...c.read, [name]: ledgerLen } });
}

/** One-line human render: `[YYYY-MM-DD HH:MM:SS] machine:from → to (task: X): body`. Shared by
 *  inbox + log. The sender's machine is part of the identity whenever the message crossed machines —
 *  without it `inbox` says `api → worker` and the reader is back to guessing which `api`. */
export function fmtMessage(msg: ChatMessage): string {
  const t = msg.ts.replace("T", " ").slice(0, 19);
  const task = msg.task ? ` (task: ${msg.task})` : "";
  const from = msg.fromMachine === null ? msg.from : `${msg.fromMachine}:${msg.from}`;
  return `[${t}] ${from} → ${msg.to}${task}: ${msg.body}`;
}

/** The next undelivered message addressed to `name`, scanning from ledger index `from`, with its
 *  absolute index — or null if none. Pure: the daemon uses `idx` to advance the per-recipient
 *  delivered cursor (past skipped non-recipient messages) and preserves in-order delivery. */
export function nextForRecipient(
  name: string,
  ledger: ChatMessage[],
  from: number,
): { msg: ChatMessage; idx: number } | null {
  for (let idx = Math.max(0, from); idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && msg.to === name) return { msg, idx };
  }
  return null;
}
