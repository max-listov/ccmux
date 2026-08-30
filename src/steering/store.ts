import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { lstatExists, readPrivate, writePrivateJson } from '../attachments/files.ts';
import { chatPrincipalKey } from '../chat/identity.ts';
import { managedRuntimeRoot } from '../runtime/status.ts';
import type { ChatPrincipal, MachineConfig, Session } from '../types.ts';
import {
  STEERING_LIMITS,
  type SteeringInput,
  type SteeringJournal,
  SteeringJournalSchema,
} from './schema.ts';

export function steeringFailure(code: string, status = 409): never {
  throw new AppError(code, 'The native steering operation is unavailable', status);
}

/** Caller holds native admission. No body or provider message is retained in this journal. */
export function readSteeringJournal(m: MachineConfig, s: Session): SteeringJournal {
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  const path = join(root, 'steering.json');
  try {
    const value = lstatExists(path)
      ? SteeringJournalSchema.parse(
          JSON.parse(readPrivate(path, STEERING_LIMITS.journalBytes).toString()),
        )
      : SteeringJournalSchema.parse({
          registration: s.registrationGeneration,
          threadId: s.uuid,
          operations: [],
        });
    if (value.registration !== s.registrationGeneration || value.threadId !== s.uuid)
      return steeringFailure('IDENTITY_MISMATCH');
    return value;
  } catch {
    return steeringFailure('STEERING_UNAVAILABLE', 503);
  }
}

export function writeSteeringJournal(m: MachineConfig, s: Session, journal: SteeringJournal): void {
  try {
    const value = SteeringJournalSchema.parse(journal);
    if (Buffer.byteLength(JSON.stringify(value)) > STEERING_LIMITS.journalBytes)
      steeringFailure('CAPACITY');
    writePrivateJson(managedRuntimeRoot(m, s), 'steering.json', value);
  } catch {
    steeringFailure('STEERING_UNAVAILABLE', 503);
  }
}

export function steeringFingerprint(principal: ChatPrincipal, input: SteeringInput): string {
  return createHash('sha256')
    .update(JSON.stringify([chatPrincipalKey(principal), input]))
    .digest('hex');
}
