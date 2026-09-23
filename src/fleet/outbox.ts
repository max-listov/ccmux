import { z } from 'zod';
import { targetLabel } from '../chat/identity.ts';
import { ChatMessageSchema } from '../chat/messageSchema.ts';
import { outboxPath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { appendJsonl, readJsonl } from '../util/jsonl.ts';
import { log } from '../util/log.ts';

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
const OutboundResultSchema = z.object({
  ok: z.boolean(), // did the remote accept it?
  detail: z.string(), // transport/remote error when !ok
});

export const OutboundSchema = z
  .object({
    kind: z.literal('msg'),
    // The exact wire envelope is retained unchanged for retries. In particular, a retry never
    // resolves a session name again after that name has been reused by another provider/thread.
    envelope: ChatMessageSchema,
    result: OutboundResultSchema,
  })
  .strict();
export type Outbound = z.infer<typeof OutboundSchema>;

export function outboundId(record: Outbound): string {
  return record.envelope.id;
}

export function outboundTimestamp(record: Outbound): string {
  return record.envelope.ts;
}

/** Append-only, one JSON per line — same shape of durability as the chat ledger. Never throws: a
 *  bookkeeping failure must not break the send it is recording. */
export function appendOutbound(m: MachineConfig, rec: Outbound): void {
  try {
    appendJsonl(outboxPath(m), OutboundSchema.parse(rec));
  } catch (e) {
    // Never throws — the send already happened, and failing here would report a delivered message as
    // an error. But it must not vanish quietly either: this record's entire purpose is to be proof
    // that we asked, so a lost one is exactly the blindness the outbox exists to end.
    const target = rec.envelope.to;
    const to =
      target.kind === 'managed' ? `${target.machine}:${target.session}` : targetLabel(target);
    log.warn({ msg: 'outbox: failed to record an outgoing message', to, err: String(e) });
  }
}

export function loadOutbox(m: MachineConfig): Outbound[] {
  return readJsonl(outboxPath(m), OUTBOX);
}

/** A malformed line costs that line, never the file: the outbox is a record of attempts. */
const OUTBOX = {
  label: 'outbox',
  badLine: 'skip',
  decode: (raw: unknown): Outbound | undefined => OutboundSchema.safeParse(raw).data,
} as const;
