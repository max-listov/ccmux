import { join } from 'node:path';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import type { ManagedRuntimeSnapshot } from './schema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

/**
 * A durable request between a caller and the process that holds a session's runtime.
 *
 * Four of these exist — interrupt, permission mode, MCP control, rewind — and one mechanism serves
 * them all: the waiting, the identity check and the retry receipt are the same question every time.
 * What differs between them is passed in rather than reimplemented, so that a difference between
 * two mailboxes is always a decision somebody made and can be read as one.
 *
 * Deliberately NOT shared: the input mailbox. It is a single-slot queue with seven parties rather
 * than a request and its reply, its phases are a crash-window protocol rather than a status, and
 * its idempotency belongs to two callers under two different and equally correct rules.
 */

/**
 * What every mailbox records: whose request this is, and which conversation it was written for.
 *
 * The phase vocabulary is deliberately NOT here. Three of the four settle into "done" or "refused",
 * but an interrupt has a third terminal-looking state — the runtime tried and does not know — and
 * collapsing that into either of the other two turns a lost acknowledgement into a false answer.
 * Each mailbox names its own phases and reads them in `settle`.
 */
export interface MailboxReceipt {
  generation: string;
}

export interface MailboxDefinition<Receipt extends MailboxReceipt, Result> {
  /** File under the session's runtime root. One topic per file, as everywhere else here. */
  file: string;
  schema: z.ZodType<Receipt, unknown>;
  /**
   * What makes a retry the same request. Named by each mailbox rather than fixed to one field:
   * three of them are asked for by an operation id, and an interrupt's operation IS the turn it
   * stops, whose id it has always stored under its own name.
   */
  identity: (receipt: Receipt) => string;
  /** How often to look, and how long to wait. Both are per-mailbox and both carry a reason. */
  pollMs: number;
  deadlineMs: number;
  /**
   * Whether this session can answer the request at all, asked against the live snapshot before
   * anything is written. Throws the refusal it wants; returning means yes.
   */
  precondition?: (snapshot: ManagedRuntimeSnapshot) => void;
  /**
   * What a receipt means. Returning `undefined` keeps polling; throwing is the runtime's refusal.
   *
   * Given the snapshot as well as the receipt because the two mailboxes that can be verified
   * against what the session republished must be, and the two that cannot must not: a rewind's
   * result exists nowhere but its receipt, and an interrupt has nothing in the snapshot to check.
   */
  settle: (
    receipt: Receipt,
    snapshot: () => ManagedRuntimeSnapshot | undefined,
  ) => Result | undefined;
  /** The error thrown when the receipt is replaced by another operation or another conversation. */
  mismatch: () => AppError;
}

export interface Mailbox<Receipt extends MailboxReceipt, Result> {
  read: (m: MachineConfig, s: Session) => Receipt | null;
  write: (m: MachineConfig, s: Session, value: Receipt) => Promise<void>;
  request: (
    m: MachineConfig,
    s: Session,
    operationId: string,
    compose: (generation: string, snapshot: ManagedRuntimeSnapshot) => Receipt,
    signal: AbortSignal,
  ) => Promise<Result>;
}

export function defineMailbox<Receipt extends MailboxReceipt, Result>(
  definition: MailboxDefinition<Receipt, Result>,
): Mailbox<Receipt, Result> {
  const path = (m: MachineConfig, s: Session) =>
    join(managedRuntimeRoot(m, s), `${definition.file}.json`);
  const read = (m: MachineConfig, s: Session) =>
    readPrivateJson(path(m, s), definition.schema) as Receipt | null;
  const write = (m: MachineConfig, s: Session, value: Receipt) =>
    atomicWrite(path(m, s), JSON.stringify(definition.schema.parse(value)), 0o600);

  return {
    read,
    write,
    async request(m, s, operationId, compose, signal) {
      const live = readManagedRuntimeStatus(m, s);
      if (live.status !== 'live' || !live.snapshot)
        throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
      definition.precondition?.(live.snapshot);
      const generation = live.snapshot.generation;
      // Fetched only when a `settle` asks for it. Two of the four never look at it, and the
      // interrupt mailbox polls forty times a second — reading the whole published status on every
      // one of those passes would be work nobody wants done.
      const republished = () => readManagedRuntimeStatus(m, s).snapshot ?? undefined;
      const prior = read(m, s);
      const mine =
        prior !== null &&
        definition.identity(prior) === operationId &&
        prior.generation === generation;
      // The same operation asked twice is one operation. Writing again would restart a request the
      // session may already be acting on, and for a rewind that is the opposite of undo.
      if (mine) {
        const settled = definition.settle(prior, republished);
        if (settled !== undefined) return settled;
      }
      // Composed only for a request that is actually new, and allowed to refuse: a check that
      // needs the request as well as the state — "this session has no such server" — belongs here
      // rather than in the precondition, and a replayed operation was already checked once.
      if (!mine) await write(m, s, compose(generation, live.snapshot));
      const until = Date.now() + definition.deadlineMs;
      while (Date.now() < until) {
        signal.throwIfAborted();
        const current = read(m, s);
        if (
          current === null ||
          definition.identity(current) !== operationId ||
          current.generation !== generation
        )
          throw definition.mismatch();
        const settled = definition.settle(current, republished);
        if (settled !== undefined) return settled;
        await Bun.sleep(definition.pollMs);
      }
      throw new AppError('UNAVAILABLE', 'The runtime did not answer the request', 503);
    },
  };
}
