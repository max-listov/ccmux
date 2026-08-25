import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CHAT_GENERATION, ChatCursorsSchema, ChatMessageSchema } from "../config/schema.ts";
import type { ChatCursors, ChatMessage, ChatPrincipal, ChatTarget, MachineConfig, ManagedPeer } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";
import { chatAckPath, chatCursorsPath, chatLedgerPath } from "../config/paths.ts";
import {
  chatTargetKey,
  managedPeerKey,
  principalLabel,
  samePrincipal,
  sameTarget,
  targetLabel,
} from "./identity.ts";

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
export function appendAck(m: MachineConfig, id: string, by: "hook" | "daemon" | "cancel", to: ChatTarget): void {
  appendFileSync(chatAckPath(m), `${JSON.stringify({ id, ts: new Date().toISOString(), by, to: chatTargetKey(to) })}\n`);
}

/** Undelivered CONDITIONAL messages (deferred or time-delayed), optionally filtered by sender /
 *  recipient / task. "Undelivered" = not yet in the ack-log (neither delivered nor already
 *  cancelled). This is the set `msg cancel` tombstones and the set a re-armed `--task` replaces.
 *  notBefore due-ness is intentionally NOT considered — a future-dated watchdog is still pending. */
export function pendingConditional(
  ledger: readonly LedgerSlot[],
  acked: Set<string>,
  filter: { from?: ChatPrincipal; to?: ChatTarget; task?: string },
): ChatMessage[] {
  return ledger.filter((msg): msg is ChatMessage => {
    if (msg === null) return false; // a record this build cannot read is not a message it can cancel
    if (!(msg.defer || msg.notBefore !== null)) return false; // immediate mail is delivered at once
    if (acked.has(msg.id)) return false; // already delivered or cancelled
    if (filter.from !== undefined && !samePrincipal(msg.from, filter.from)) return false;
    if (filter.to !== undefined && !sameTarget(msg.to, filter.to)) return false;
    if (filter.task !== undefined && msg.task !== filter.task) return false;
    return true;
  });
}

/**
 * What every generation-2 record carries, with room for what a newer build may add.
 *
 * This is the line between "written by something newer" and "malformed". Without it the two are
 * indistinguishable, and treating them alike costs one way or the other: refuse both and a routine
 * upgrade takes down the whole ledger; skip both and a writer bug disappears silently.
 *
 * `from`/`to` are checked only as far as "an object naming its kind" — a NEW kind of address is
 * precisely what a newer build is expected to introduce, while a record whose sender is a bare
 * string is not from the future, it is broken.
 */
const LedgerCoreSchema = z
  .object({
    v: z.literal(CHAT_GENERATION),
    id: z.string(),
    ts: z.string(),
    from: z.object({ kind: z.string() }).loose(),
    to: z.object({ kind: z.string() }).loose(),
    body: z.string(),
    task: z.string().nullable(),
    defer: z.boolean(),
    onBehalfOf: z.string().nullable(),
    notBefore: z.string().nullable(),
  })
  .loose();

/**
 * One position in the ledger. `null` = a record this build cannot read.
 *
 * The hole is kept rather than dropped, and that is the whole reason this is a type instead of a
 * shorter array. **Delivery cursors are positions in this array.** Drop an unreadable record and
 * every later index shifts, so a cursor written by one build points at a different message when read
 * by another — messages re-delivered, or skipped and never seen. A hole costs a null check; a shift
 * costs mail.
 */
export type LedgerSlot = ChatMessage | null;

/**
 * Parse one record: a message, or `null` for one this build is not equipped to read.
 *
 * Two failures that look alike and must not be treated alike:
 *
 *  - **A record from a NEWER generation, or one that fails this build's schema.** That is version
 *    skew, and skew is routine: the fleet upgrades over minutes and a rollback is a legitimate
 *    operation, so there is always a window where one machine writes what another does not know.
 *    Refusing the whole file for it would take down `msg`, `inbox`, delivery and the TUI at once —
 *    every one of them reads the ledger through here. So the record is skipped and its position
 *    kept.
 *  - **A record from an OLDER generation.** That is not skew, it is a migration that was never done,
 *    and it still fails loudly with the same instruction as before. Silently skipping those would
 *    hide a whole conversation history from the person who has to move it.
 *
 * Strict parsing alone would reject an older record too — but by complaining about the shape of
 * `from`, which reads as a bug in the writer. The generation is checked first and said first, so the
 * answer is "this record predates the identity model" and the next step is obvious.
 */
export function parseRecord(raw: unknown, where: string): LedgerSlot {
  const generation = raw !== null && typeof raw === "object" && "v" in raw ? raw.v : undefined;
  if (generation !== CHAT_GENERATION) {
    // A NEWER generation is skew by definition — nothing is asked of anyone, the machine reads those
    // records once it is upgraded. An OLDER one is a migration that was never done, and it needs a
    // person; the two are not symmetric and must not be treated alike.
    if (typeof generation === "number" && generation > CHAT_GENERATION) return null;
    const found = generation === undefined ? "none" : String(generation);
    throw new Error(
      `${where} — chat record generation ${found}, this build reads ${CHAT_GENERATION}. ` +
        `Records from before the identity model are not readable here; move them under archive/.`,
    );
  }
  const message = ChatMessageSchema.safeParse(raw).data;
  if (message !== undefined) return message;
  // Same generation, unfamiliar shape. Two very different things look like this, and the difference
  // is decided rather than assumed: a record that still carries the whole generation-2 core is a
  // newer build's extension — an added field, a kind of address this one has no case for — and is
  // skipped. A record missing that core is malformed, and still fails loudly, because a writer bug
  // that goes quiet is a bug nobody fixes.
  if (LedgerCoreSchema.safeParse(raw).success) return null;
  throw new Error(`${where} — chat record is generation ${CHAT_GENERATION} but malformed: it is missing fields every record of this generation carries`);
}

/**
 * Read the whole ledger in order, positions intact.
 *
 * A line that is not JSON still fails LOUD: single-line `O_APPEND` writes are atomic, so malformed
 * text means the file was damaged by something other than this program, and quietly continuing past
 * real damage is how an append-only history stops being one.
 */
export function loadLedger(m: MachineConfig): LedgerSlot[] {
  const { ledger } = chatPaths(m);
  if (!existsSync(ledger)) return [];
  const out: LedgerSlot[] = [];
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
    out.push(parseRecord(raw, `chat ledger:${i + 1}`));
  }
  return out;
}

/** Records present in the file that this build cannot read. Reported by `inbox` and `doctor`,
 *  because a skipped record must be VISIBLE somewhere — the alternative is history disappearing
 *  quietly, which is the one thing an append-only ledger exists to prevent. */
export function unreadableCount(slots: readonly LedgerSlot[]): number {
  return slots.reduce((n, slot) => (slot === null ? n + 1 : n), 0);
}

/** Append one message. O_APPEND (flag "a") makes a single line write atomic across concurrent
 *  senders — no read-modify-write race, no interleave. The ledger is never rewritten. */
export function appendMessage(m: MachineConfig, msg: ChatMessage): void {
  const { ledger } = chatPaths(m);
  const parsed = ChatMessageSchema.parse(msg);
  appendFileSync(ledger, `${JSON.stringify(parsed)}\n`);
}

/** Atomically admit an idempotent remote envelope across competing receiver processes. The lock
 * covers check+append, not merely line integrity. A crashed holder becomes reclaimable after 30s. */
export async function appendMessageOnce(m: MachineConfig, msg: ChatMessage): Promise<boolean> {
  const { ledger } = chatPaths(m);
  const lock = `${ledger}.receive-lock`;
  mkdirSync(dirname(ledger), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
      } catch {
        // The holder released it between checks.
      }
      if (Date.now() >= deadline) throw new Error("chat receive lock timed out");
      await Bun.sleep(20);
    }
  }
  try {
    if (loadLedger(m).some((item) => item?.id === msg.id)) return false;
    appendMessage(m, msg);
    return true;
  } finally {
    rmdirSync(lock);
  }
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
  recipient: ManagedPeer,
  ledger: readonly LedgerSlot[],
  cursors: ChatCursors,
  acked?: ReadonlySet<string>,
): { msg: ChatMessage; idx: number }[] {
  const key = managedPeerKey(recipient);
  const since = cursors.read[key] ?? 0;
  const out: { msg: ChatMessage; idx: number }[] = [];
  for (let idx = since; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (!msg || msg.to.kind !== "managed" || managedPeerKey(msg.to) !== key) continue;
    if (acked?.has(msg.id) === true) continue; // already injected (Stop hook or daemon) — not pending
    out.push({ msg, idx });
  }
  return out;
}

/** Advance a recipient's read cursor to the whole-ledger length (everything up to now seen). */
export async function markRead(m: MachineConfig, recipient: ManagedPeer, ledgerLen: number): Promise<void> {
  const c = loadCursors(m);
  await saveCursors(m, { ...c, read: { ...c.read, [managedPeerKey(recipient)]: ledgerLen } });
}

/** One-line human render with the complete pinned endpoint identities. Shared by inbox + log. */
export function fmtMessage(msg: ChatMessage): string {
  const t = msg.ts.replace("T", " ").slice(0, 19);
  const task = msg.task ? ` (task: ${msg.task})` : "";
  return `[${t}] ${principalLabel(msg.from)} → ${targetLabel(msg.to)}${task}: ${msg.body}`;
}

/** The next undelivered message addressed to an exact managed peer, scanning from ledger index `from`, with its
 *  absolute index — or null if none. Pure: the daemon uses `idx` to advance the per-recipient
 *  delivered cursor (past skipped non-recipient messages) and preserves in-order delivery. */
export function nextForRecipient(
  recipient: ManagedPeer,
  ledger: ChatMessage[],
  from: number,
): { msg: ChatMessage; idx: number } | null {
  const key = managedPeerKey(recipient);
  for (let idx = Math.max(0, from); idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && msg.to.kind === "managed" && managedPeerKey(msg.to) === key) return { msg, idx };
  }
  return null;
}
