import { z } from 'zod';
import type { MachineConfig, Session } from '../../types.ts';
import { readFirstLine } from '../../util/readLines.ts';
import { codexRolloutFiles, currentRolloutFile } from './rolloutFiles.ts';

const RolloutSessionMetaSchema = z.looseObject({
  type: z.literal('session_meta'),
  payload: z.looseObject({ id: z.uuid() }),
});

export type RolloutReadiness =
  | { status: 'missing'; path: null; detail: 'rollout-missing' }
  | { status: 'pending'; path: string; detail: 'metadata-unpublished' | 'metadata-invalid' }
  | { status: 'ready'; path: string; detail: null };

/**
 * The Codex session's current rollout: the newest uncompressed file of its thread under
 * ~/.codex/sessions/Y/M/D/ (a split thread has several, see `rolloutFiles.ts`). After pending
 * bootstrap promotion, the registry uuid IS Codex's thread id. Null when no uncompressed file exists —
 * which, for a thread Codex has compressed while idle, is not "no conversation": ask
 * `codexHistoryPresent` for that.
 */
export function historyFile(s: Session, m: MachineConfig): string | null {
  return currentRolloutFile(codexRolloutFiles(m.codexSessionsDir, s.uuid))?.path ?? null;
}

/** The conversation exists on disk in any form Codex keeps it: plain, split or compressed. Codex
 *  resumes a compressed thread itself; a supervisor that only looked for `.jsonl` blocked such a
 *  session as "missing rollout". */
export function codexHistoryPresent(s: Session, m: MachineConfig): boolean {
  return codexRolloutFiles(m.codexSessionsDir, s.uuid).length > 0;
}

/**
 * A rollout path becomes visible before its first JSONL record is necessarily committed. Provider
 * readers treat the newline-terminated `session_meta` record as the publication boundary, so a
 * fresh managed turn must wait for that same boundary instead of treating file existence as ready.
 */
export function rolloutReadiness(s: Session, m: MachineConfig): RolloutReadiness {
  const path = historyFile(s, m);
  if (path === null) return { status: 'missing', path: null, detail: 'rollout-missing' };
  const first = readFirstLine(path);
  if (first === null) return { status: 'pending', path, detail: 'metadata-unpublished' };
  try {
    const metadata = RolloutSessionMetaSchema.parse(JSON.parse(first));
    if (metadata.payload.id !== s.uuid)
      return { status: 'pending', path, detail: 'metadata-invalid' };
    return { status: 'ready', path, detail: null };
  } catch {
    return { status: 'pending', path, detail: 'metadata-invalid' };
  }
}
