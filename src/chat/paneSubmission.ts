import { join } from 'node:path';
import { z } from 'zod';
import { managedRuntimeRoot } from '../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJson } from '../runtime/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import { writeEphemeralSnapshot } from '../util/atomic.ts';

/**
 * The moment the daemon last pressed Enter on a letter in a TUI session's pane.
 *
 * Between that Enter and the first sign of the turn — the agent painting "working", the prompt in
 * its transcript, the submit hook — the pane still looks idle. A sleep decision taken in that
 * window would release the agent with the letter typed and its turn never started; for Claude,
 * which has no transcript pickup, that letter is then gone while the ledger says delivered. The
 * mark is written under the session's admission lock, the lock the sleep decision takes too, so a
 * decision either sees the mark or runs before the delivery does.
 */
const PaneSubmissionSchema = z
  .object({ messageId: z.string().min(1).max(256), at: z.number().int().positive() })
  .strict();

const markPath = (m: Pick<MachineConfig, 'stateDir'>, s: Pick<Session, 'name' | 'uuid'>) =>
  join(managedRuntimeRoot(m, s), 'pane-submission.json');

export function recordPaneSubmission(
  m: Pick<MachineConfig, 'stateDir'>,
  s: Pick<Session, 'name' | 'uuid'>,
  messageId: string,
  at = Date.now(),
): void {
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  writeEphemeralSnapshot(markPath(m, s), JSON.stringify({ messageId, at }));
}

/** The last submission when it is younger than `withinMs`, else null (missing or unreadable too). */
export function recentPaneSubmission(
  m: Pick<MachineConfig, 'stateDir'>,
  s: Pick<Session, 'name' | 'uuid'>,
  withinMs: number,
  now = Date.now(),
): z.infer<typeof PaneSubmissionSchema> | null {
  const mark = readPrivateJson(markPath(m, s), PaneSubmissionSchema, 4096);
  return mark !== null && now - mark.at >= 0 && now - mark.at < withinMs ? mark : null;
}
