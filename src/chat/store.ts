import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChatCursorsSchema, ChatMessageSchema } from "../config/schema.ts";
import type { ChatCursors, ChatMessage, MachineConfig } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";

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
 * Inter-agent chat storage — an append-only ledger (source of truth) + a small cursors file.
 * Both live next to the sessions registry (so a temp CCMUX_SESSIONS in tests gives temp chat
 * files too, and a machine keeps one chat store beside its one session store).
 */
export function chatPaths(m: MachineConfig): { ledger: string; cursors: string } {
  const dir = dirname(m.sessionsFile);
  return { ledger: join(dir, ".ccmux-chat.jsonl"), cursors: join(dir, ".ccmux-chat-cursors.json") };
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

/** Unread inbox for a recipient: messages addressed TO it at/after its read cursor, with their
 *  absolute ledger index (messages to other sessions are skipped, so addressing stays targeted). */
export function unreadFor(
  name: string,
  ledger: ChatMessage[],
  cursors: ChatCursors,
): { msg: ChatMessage; idx: number }[] {
  const since = cursors.read[name] ?? 0;
  const out: { msg: ChatMessage; idx: number }[] = [];
  for (let idx = since; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && msg.to === name) out.push({ msg, idx });
  }
  return out;
}

/** Advance a recipient's read cursor to the whole-ledger length (everything up to now seen). */
export async function markRead(m: MachineConfig, name: string, ledgerLen: number): Promise<void> {
  const c = loadCursors(m);
  await saveCursors(m, { ...c, read: { ...c.read, [name]: ledgerLen } });
}

/** One-line human render: `[YYYY-MM-DD HH:MM:SS] from → to (task: X): body`. Shared by inbox + log. */
export function fmtMessage(msg: ChatMessage): string {
  const t = msg.ts.replace("T", " ").slice(0, 19);
  const task = msg.task ? ` (task: ${msg.task})` : "";
  return `[${t}] ${msg.from} → ${msg.to}${task}: ${msg.body}`;
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
