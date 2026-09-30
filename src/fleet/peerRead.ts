import { LogPayloadSchema } from '../chat/feedSchema.ts';
import { localRows, mergeFleetLog } from '../chat/fleetLog.ts';
import { loadLedger } from '../chat/ledger.ts';
import { readInventory } from '../events/inventory.ts';
import { collectRows, type ListRow, toListItem } from '../inventory/rows.ts';
import { releaseStanding } from '../release/check.ts';
import type { ListJson, MachineConfig } from '../types.ts';
import { VERSION } from '../util/version.ts';
import { loadOutboxAcked } from './flush.ts';
import { loadOutbox } from './outbox.ts';
import { pack } from './peerDelta.ts';

/**
 * What a fleet reader on another machine asks this one, answered by the daemon.
 *
 * Every fleet read used to start a CLI on the peer, and that CLI built the answer cold: the session
 * rows read transcript tails and parsed the chat ledger from scratch, about half a second of CPU
 * per read on a machine with two dozen sessions, four reads a minute. The daemon holds the same
 * caches warm and builds the same rows in a tenth of that. So the peer's command only relays: it
 * asks the daemon over the local control socket and prints the answer (`commands/peerRead.ts`).
 *
 * The answers are the ones a peer used to print — `list --json` and `chat log --json` — packed by
 * change against the rows the reader names (`peerDelta.ts`). This contract is local and internal:
 * it is served on the control socket beside the published contracts (`peerReadContract.ts`).
 */

/** This machine's `list --json` answer. */
export function listAnswer(m: MachineConfig, rows: readonly ListRow[]): ListJson {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    rcPrefix: m.rcPrefix,
    stateDir: m.stateDir,
    release: releaseStanding(m, VERSION),
    sessions: rows.map((r) => toListItem(m, r)),
    inventory: readInventory(m),
  };
}

/**
 * The list answer for a reader that already holds some of it: each session and inventory row it
 * names by digest comes back as that digest. Uptime travels beside the rows, because it moves every
 * second while nothing happens.
 */
export function packListAnswer(answer: ListJson, known: ReadonlySet<string>): unknown {
  return {
    ...answer,
    sessions: pack(answer.sessions, known, ({ uptime, ...stable }) => ({
      stable,
      volatile: uptime,
    })),
    inventory:
      answer.inventory === null
        ? null
        : { ...answer.inventory, sessions: pack(answer.inventory.sessions, known) },
  };
}

/** Both halves of this machine's exchange — what arrived and what it sent — newest `limit` kept. */
export function localLogPayload(m: MachineConfig, limit: number) {
  const machines = [{ machine: m.rcPrefix, ok: true, error: null }];
  const rows = localRows(m.rcPrefix, loadLedger(m), loadOutbox(m), loadOutboxAcked(m));
  return LogPayloadSchema.parse({ machines, rows: mergeFleetLog([{ rows }], limit) });
}

export async function peerListAnswer(
  m: MachineConfig,
  known: readonly string[],
  rows?: readonly ListRow[],
): Promise<Record<string, unknown>> {
  return packListAnswer(listAnswer(m, rows ?? (await collectRows(m))), new Set(known)) as Record<
    string,
    unknown
  >;
}

export function peerChatLogAnswer(
  m: MachineConfig,
  limit: number,
  known: readonly string[],
): Record<string, unknown> {
  const payload = localLogPayload(m, limit);
  return { ...payload, rows: pack(payload.rows, new Set(known)) };
}
