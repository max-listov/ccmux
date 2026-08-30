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
    images: AttachmentReferencesSchema.optional(),
    turnOptions: AcceptedTurnOptionsSchema.optional(),
    continuations: NativeContinuationsSchema.default([]),
    terminal: z.enum(['completed', 'interrupted', 'failed']).optional(),
  })
  .strict();
export type RuntimeInput = z.infer<typeof RuntimeInputSchema>;
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'input.json');
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

export const runtimeInputId = (s: Pick<Session, 'agent'>, messageId: string, timestamp: number) =>
  s.agent === 'custom' ? messageId : openCodeMessageId(messageId, timestamp);
