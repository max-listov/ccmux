import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from 'stitchkit';
import { writeFileAtomicSync } from 'stitchkit/files';
import { z } from 'zod';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { readSelection } from '../runtime/selection.ts';
import { loadSessions } from '../session/registry.ts';
import type { ChatMessage, MachineConfig } from '../types.ts';
import { appendJsonl, readJsonl } from '../util/jsonl.ts';
import { withLock } from '../util/lock.ts';
import { CHAT_GENERATION, ChatCursorsSchema, ChatMessageSchema } from './messageSchema.ts';
import { chatPaths } from './store.ts';

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
export const LedgerCoreSchema = z
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
  const generation = raw !== null && typeof raw === 'object' && 'v' in raw ? raw.v : undefined;
  if (generation !== CHAT_GENERATION) {
    // A NEWER generation is skew by definition — nothing is asked of anyone, the machine reads those
    // records once it is upgraded. An OLDER one is a migration that was never done, and it needs a
    // person; the two are not symmetric and must not be treated alike.
    if (typeof generation === 'number' && generation > CHAT_GENERATION) return null;
    const found = generation === undefined ? 'none' : String(generation);
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
  throw new Error(
    `${where} — chat record is generation ${CHAT_GENERATION} but malformed: it is missing fields every record of this generation carries`,
  );
}

/**
 * Read the whole ledger in order, positions intact.
 *
 * A line that is not JSON still fails LOUD: single-line `O_APPEND` writes are atomic, so malformed
 * text means the file was damaged by something other than this program, and quietly continuing past
 * real damage is how an append-only history stops being one.
 */
export function loadLedger(m: MachineConfig): LedgerSlot[] {
  return readJsonl(chatPaths(m).ledger, LEDGER);
}

/** A damaged ledger line is refused, never skipped: see `loadLedger`. A line still being written
 *  without its newline is not a record yet, and is read once it is whole (`readJsonl`). */
export const LEDGER = {
  label: 'chat ledger',
  badLine: 'throw',
  decode: (raw: unknown, line: number): LedgerSlot => parseRecord(raw, `chat ledger:${line}`),
} as const;

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
  if (
    parsed.to.kind === 'managed' &&
    parsed.to.machine === m.rcPrefix &&
    parsed.turnOptions === undefined
  ) {
    const target = parsed.to;
    const session = loadSessions(m).find(
      (row) =>
        row.name === target.session && row.uuid === target.threadId && row.agent === target.agent,
    );
    if (session && hasNativeRuntime(session)) {
      const selected = readSelection(m, session);
      if (selected === null)
        throw new Error('Native selection is unavailable before message acceptance');
      parsed.turnOptions = selected;
    }
  }
  // A ledger is born with its cursors. Without this, the first letter on a new machine could be written
  // before the daemon's first pass creates them — and a ledger without cursors reads as one whose
  // cursors were lost, which resumes at the present and would step over that very letter.
  if (!existsSync(ledger) && !existsSync(chatPaths(m).cursors)) {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileAtomicSync(
      chatPaths(m).cursors,
      `${JSON.stringify(ChatCursorsSchema.parse({}), null, 2)}\n`,
    );
  }
  appendJsonl(ledger, parsed);
}

/** Atomically admit an idempotent remote envelope across competing receiver processes. The lock
 * covers check+append, not merely line integrity. A crashed holder becomes reclaimable after 30s. */
export async function appendMessageOnce(
  m: MachineConfig,
  msg: ChatMessage,
  signal?: AbortSignal,
): Promise<boolean> {
  const { ledger } = chatPaths(m);
  mkdirSync(dirname(ledger), { recursive: true });
  // The shared lock, not one of its own: this one used to be a bare directory reclaimed by age, with
  // no owner, so a holder slower than the reclaim window lost it to a second receiver — and then its
  // own `finally` removed the lock that second receiver was holding.
  return withLock(
    `${ledger}.receive-lock`,
    async () => {
      signal?.throwIfAborted();
      return admitOnce(m, msg);
    },
    'chat receive',
    10_000,
    signal,
  );
}

/** Check and append under the receive lock: a retry of an accepted id is a no-op, a different
 *  request under the same id is a conflict. */
export function admitOnce(m: MachineConfig, msg: ChatMessage): boolean {
  const prior = loadLedger(m).find((item) => item?.id === msg.id);
  if (prior) {
    // Native selection can be resolved by the recipient on first append. All caller-supplied
    // immutable fields, including provenance/audience, must match on a transport retry.
    const { turnOptions: acceptedOptions, ...accepted } = prior;
    const { turnOptions: requestedOptions, ...requested } = msg;
    if (
      stableJson(accepted) !== stableJson(requested) ||
      (requestedOptions !== undefined &&
        stableJson(acceptedOptions) !== stableJson(requestedOptions))
    )
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Message ID already belongs to a different request',
        409,
      );
    return false;
  }
  appendMessage(m, msg);
  return true;
}
