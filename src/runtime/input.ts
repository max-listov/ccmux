import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AttachmentReferencesSchema } from '../attachments/reference.ts';
import { NativeContinuationsSchema } from '../chat/messageOperationSchema.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { AcceptedTurnOptionsSchema } from './selectionSchema.ts';
import { managedRuntimeRoot } from './status.ts';
import { readPrivateJson } from './store.ts';

export const RuntimeInputSchema = z
  .object({
    messageId: z.uuid(),
    nativeId: z.string().min(1).max(256),
    text: z.string().min(1).max(32_768),
    phase: z.enum(['queued', 'dispatching', 'accepted', 'uncertain']),
    /**
     * The native turn this input started, when the runtime names its turns itself.
     *
     * Claude and OpenCode take `nativeId` as the turn's own id; a Codex App Server answers `turn/start`
     * with an id of its choosing. Written with `accepted`; absent means the turn is `nativeId`.
     */
    turnId: z.string().min(1).max(256).optional(),
    /**
     * When the dispatch that is still in flight began.
     *
     * Written with `dispatching`, and read only by whoever has to decide what an interrupted
     * dispatch means. Without it a reconciliation can only match a turn by its words, and the same
     * words sent twice make the older turn look like a receipt for the newer one.
     */
    dispatchedAt: z.string().optional(),
    /**
     * A message is framed for its recipient; a command is delivered verbatim.
     *
     * The distinction is load-bearing, not cosmetic: every chat-delivered message is prefixed with
     * its sender attribution, and a slash command carrying that prefix is no longer a command — the
     * runtime reads it as text that happens to mention one.
     */
    kind: z.enum(['message', 'command']).default('message'),
    images: AttachmentReferencesSchema.optional(),
    turnOptions: AcceptedTurnOptionsSchema.optional(),
    continuations: NativeContinuationsSchema.default([]),
    terminal: z.enum(['completed', 'interrupted', 'failed']).optional(),
  })
  .strict();
export type RuntimeInput = z.infer<typeof RuntimeInputSchema>;
/** Where a session's single input slot lives. Exported because when it was WRITTEN is evidence. */
export const runtimeInputPath = (m: MachineConfig, s: Session) =>
  join(managedRuntimeRoot(m, s), 'input.json');
const path = runtimeInputPath;
export function readRuntimeInput(m: MachineConfig, s: Session): RuntimeInput | null {
  const input = readPrivateJson(path(m, s), RuntimeInputSchema);
  if (input !== null) return input;
  try {
    lstatSync(path(m, s));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error('Native dispatch journal cannot be inspected', { cause: error });
  }
  throw new Error('Native dispatch journal is invalid');
}
export const writeRuntimeInput = (
  m: MachineConfig,
  s: Session,
  input: z.input<typeof RuntimeInputSchema>,
): Promise<void> => atomicWrite(path(m, s), JSON.stringify(RuntimeInputSchema.parse(input)), 0o600);

/** Native IDs embed creation order. The durable ledger ID provides the collision-resistant suffix. */
export function openCodeMessageId(messageId: string, timestamp: number): string {
  const time = (BigInt(timestamp) * 4096n).toString(16).padStart(12, '0').slice(-12);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const suffix = [...createHash('sha256').update(messageId).digest().subarray(0, 14)]
    .map((byte) => alphabet.charAt(byte % alphabet.length))
    .join('');
  return `msg_${time}${suffix}`;
}

/**
 * The id a queued input is submitted under. Custom and Codex take the ledger message id itself —
 * Codex as the turn's client id, which is what finds the turn again when `turn/start`'s response is
 * lost; the others need an id shaped the way their runtime orders messages.
 */
export const runtimeInputId = (s: Pick<Session, 'agent'>, messageId: string, timestamp: number) =>
  s.agent === 'custom' || s.agent === 'codex' ? messageId : openCodeMessageId(messageId, timestamp);

/** The native turn an accepted input started. */
export const inputTurnId = (input: Pick<RuntimeInput, 'nativeId' | 'turnId'>): string =>
  input.turnId ?? input.nativeId;
