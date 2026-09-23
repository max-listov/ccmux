import type { TranscriptRead } from '../agent/transcript/transcriptRead.ts';
import { rcName } from '../config/machine.ts';
import type { MachineConfig, Session, TranscriptJson } from '../types.ts';
import { VERSION } from '../util/version.ts';
import { readTranscriptWindow, type TranscriptWindowOptions } from './transcriptWindow.ts';

/**
 * One session's transcript window as the published answer.
 *
 * Built here for both the command and the control service, because two builders of the same answer
 * drift — and this one carries the cursor a consumer hands back, so a drift between them would be a
 * consumer paging through a slightly different conversation depending on how it asked.
 */
export async function transcriptJson(
  m: MachineConfig,
  s: Session,
  window: TranscriptWindowOptions,
  signal?: AbortSignal,
): Promise<TranscriptJson> {
  const read = await readTranscriptWindow(m, s, window, signal);
  return transcriptReadJson(m, s, read);
}

export function transcriptReadJson(
  m: MachineConfig,
  s: Pick<Session, 'name' | 'uuid' | 'dir'>,
  read: TranscriptRead,
  rc = rcName(m, s.name),
): TranscriptJson {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    session: { name: s.name, uuid: s.uuid, rc, dir: s.dir, machine: m.rcPrefix },
    source: {
      kind: read.available
        ? read.source === 'native'
          ? `${read.agent}-native`
          : `${read.agent}-jsonl`
        : 'unavailable',
      path: read.path,
      available: read.available,
      error: read.error,
    },
    cursor: {
      opaque: read.available ? String(read.totalLines) : null,
      line: read.available ? read.totalLines : null,
      byteOffset: null,
      mtimeMs: read.mtimeMs,
    },
    window: {
      firstLine: read.firstLine,
      lastLine: read.totalLines,
      reachedStart: read.reachedStart,
    },
    stats: read.stats,
    messages: read.messages,
  };
}
