import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { log } from "../util/log.ts";
import type { MachineConfig } from "../types.ts";
import { outboxPath } from "../config/paths.ts";

/**
 * What THIS machine sent to other machines.
 *
 * The gap it fills: in the 2026-08-05 incident the initiator had no record at all that it had asked
 * anything — the task went out as an ssh command, so only the RECEIVER's ledger knew. Half the
 * exchange was invisible, and "I'm waiting on a report" lived solely in an agent's head.
 *
 * Deliberately a SEPARATE file rather than a record in the chat ledger. An outgoing row addressed to
 * `api` on another machine would otherwise be picked up by this machine's own delivery loop (which
 * matches purely on `to === session.name`) and pasted into a local same-named session — literally
 * re-creating the bug this whole feature removes. A separate file also means zero edits to delivery,
 * the Stop hook, cursors, rate limiting and the Telegram mirror, and an older ccmux simply ignores it.
 *
 * Failed transit is recorded too: "it never left" must be as visible as "it went".
 */
export const OutboundSchema = z.object({
  id: z.string(),
  ts: z.string(),
  from: z.string(), // sending session on this machine, or "cli"
  toMachine: z.string(),
  toSession: z.string(),
  kind: z.enum(["msg", "restart-then"]),
  body: z.string(),
  task: z.string().nullable().default(null),
  ok: z.boolean(), // did the remote accept it?
  detail: z.string().default(""), // transport/remote error when !ok
});
export type Outbound = z.infer<typeof OutboundSchema>;

/** Append-only, one JSON per line — same shape of durability as the chat ledger. Never throws: a
 *  bookkeeping failure must not break the send it is recording. */
export function appendOutbound(m: MachineConfig, rec: Outbound): void {
  try {
    const p = outboxPath(m);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(OutboundSchema.parse(rec))}\n`);
  } catch (e) {
    // Never throws — the send already happened, and failing here would report a delivered message as
    // an error. But it must not vanish quietly either: this record's entire purpose is to be proof
    // that we asked, so a lost one is exactly the blindness the outbox exists to end.
    log.warn({ msg: "outbox: failed to record an outgoing message", to: `${rec.toMachine}:${rec.toSession}`, err: String(e) });
  }
}

export function loadOutbox(m: MachineConfig): Outbound[] {
  const p = outboxPath(m);
  if (!existsSync(p)) return [];
  const out: Outbound[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = OutboundSchema.safeParse(JSON.parse(line)).data;
      if (rec !== undefined) out.push(rec);
    } catch {
      // skip a malformed line rather than lose the whole file
    }
  }
  return out;
}
