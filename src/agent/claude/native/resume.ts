import { existsSync } from 'node:fs';
import type { MachineConfig, Session } from '../../../types.ts';
import { histFile } from '../resume.ts';

/**
 * Whether the next start resumes the pinned conversation or creates it.
 *
 * Two things must both be true, and the marker alone was not enough. It is written when the
 * runtime's stream produces its FIRST message — which includes the runtime's own opening frame —
 * so a session that never took a turn still carried a marker for a conversation the provider never
 * persisted. Every later start then resumed an id that does not exist, failed identically forever,
 * and the session sat blocked over a conversation with nothing in it. Three did, for hours.
 *
 * The file's ABSENCE is the proof that starting fresh loses nothing; its presence is why this is
 * not simply "always start new", which would discard real history on any transient failure. The
 * interactive mode has always decided it this way — the native path was the one asking a marker
 * instead of the runtime.
 */
export function resumesConversation(
  m: Pick<MachineConfig, 'projectsDir'>,
  session: Pick<Session, 'dir' | 'nativeSession'>,
  startedFile: string,
): boolean {
  const id = session.nativeSession?.id;
  if (id === undefined) return false;
  return existsSync(startedFile) && existsSync(histFile(session.dir, id, m.projectsDir));
}
