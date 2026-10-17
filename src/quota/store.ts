import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { STATE_DIR } from '../config/paths.ts';
import { PlanLimitsSchema } from '../runtime/planLimits.ts';
import { atomicWrite } from '../util/atomic.ts';

/**
 * The last thing a probe learned about one profile, kept so a read never has to ask again.
 *
 * Keyed by the PROFILE (`claude:<dir>`, `codex:<home>`), not by the account in it: who is signed in
 * is one of the things a probe finds out, and an account that changes under the same profile must
 * not inherit the previous one's windows. A failure is recorded beside the last good answer rather
 * than replacing it — the old windows still stand (with their own age), and the reason the newest
 * attempt did not refresh them is what tells "nobody spent since" from "we could not ask".
 */
export const QuotaRecordSchema = z.object({
  key: z.string().min(1).max(512),
  provider: z.enum(['claude', 'codex']),
  /** Who was signed in at the last good answer. */
  label: z.string().min(1).max(256).nullable(),
  plan: z.string().min(1).max(64).nullable(),
  /** The vendor's own name for how the account is served (`firstParty`, `chatgpt`). */
  accountProvider: z.string().min(1).max(64).nullable().default(null),
  limits: PlanLimitsSchema.nullable(),
  /** Why the newest attempt failed; null when it succeeded. */
  error: z.string().max(200).nullable(),
  attemptedAt: z.iso.datetime(),
  /** Consecutive failed attempts, which sets how long to leave the profile alone. */
  failures: z.number().int().min(0),
});
export type QuotaRecord = z.infer<typeof QuotaRecordSchema>;

const DIR = `${STATE_DIR}/quota`;
const safe = (key: string): string => key.replace(/[^\w.-]/g, '_');
const pathOf = (key: string): string => `${DIR}/${safe(key)}.json`;

export function readQuotaRecord(key: string): QuotaRecord | null {
  try {
    const path = pathOf(key);
    if (!existsSync(path)) return null;
    const parsed = QuotaRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success && parsed.data.key === key ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeQuotaRecord(record: QuotaRecord): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  await atomicWrite(pathOf(record.key), JSON.stringify(QuotaRecordSchema.parse(record)));
}
