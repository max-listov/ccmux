import type { Outbound } from '../fleet/outbox.ts';
import { outboundId, outboundTimestamp } from '../fleet/outbox.ts';
import type { LogMachine, LogRow } from './feedSchema.ts';
import { principalLabel, targetLabel } from './identity.ts';
import { unknownMessageOrigin } from './originSchema.ts';
import type { LedgerSlot } from './store.ts';

export {
  type LogMachine,
  LogMachineSchema,
  type LogPayload,
  LogPayloadSchema,
  type LogRow,
  LogRowSchema,
} from './feedSchema.ts';

/**
 * One ledger record as a row. ONE definition, used by the snapshot and by the feed alike — two
 * renderings of the same record that could drift is precisely the kind of difference nobody notices
 * until a consumer is reading both.
 *
 * A record this build cannot read still happened, so it becomes a row saying so rather than being
 * closed over: the one thing an append-only history must never do is look shorter than it is.
 */
export function rowFromLedgerRecord(machine: string, msg: LedgerSlot): LogRow {
  if (msg === null) {
    return {
      messageId: null,
      sender: null,
      target: null,
      origin: unknownMessageOrigin(),
      notification: 'conversation',
      registrationGeneration: null,
      machine,
      ts: '',
      kind: 'chat',
      from: '?',
      to: '?',
      task: null,
      body: '(a record this ccmux cannot read — written by a newer build)',
      note: '',
    };
  }
  return {
    machine,
    ts: msg.ts,
    messageId: msg.id,
    sender: msg.from,
    target: msg.to,
    origin: msg.origin ?? unknownMessageOrigin(),
    notification: msg.notification ?? 'conversation',
    registrationGeneration: msg.registrationGeneration ?? null,
    kind: 'chat',
    // A remote sender is shown with its machine, because that is the only rendering from which a
    // full pinned source can be read directly — no cwd/name inference is needed.
    from: principalLabel(msg.from),
    to: targetLabel(msg.to),
    task: msg.task,
    body: msg.body,
    note: '',
  };
}

/** One outbox record as a row. A failed send the daemon later drained is no longer bad news —
 *  saying otherwise would send someone chasing a message that did arrive. */
export function rowFromOutbound(
  machine: string,
  o: Outbound,
  settled: ReadonlySet<string> = new Set(),
): LogRow {
  return {
    machine,
    ts: outboundTimestamp(o),
    messageId: o.envelope.id,
    sender: o.envelope.from,
    target: o.envelope.to,
    origin: o.envelope.origin ?? unknownMessageOrigin(),
    notification: o.envelope.notification ?? 'conversation',
    registrationGeneration: o.envelope.registrationGeneration ?? null,
    kind: 'sent',
    from: principalLabel(o.envelope.from),
    to: targetLabel(o.envelope.to),
    task: o.envelope.task,
    body: o.envelope.body,
    note: o.result.ok
      ? ''
      : settled.has(outboundId(o))
        ? 'sent later, on retry'
        : `NOT SENT — ${o.result.detail === '' ? 'unknown error' : o.result.detail}`,
  };
}

/** Ledger + outbox of ONE machine as a single row list, oldest first. Pure. */
export function localRows(
  machine: string,
  ledger: readonly LedgerSlot[],
  outbox: Outbound[],
  settled: ReadonlySet<string> = new Set(),
): LogRow[] {
  const rows = [
    ...ledger.map((msg) => rowFromLedgerRecord(machine, msg)),
    ...outbox.map((o) => rowFromOutbound(machine, o, settled)),
  ];
  return sortByTime(rows);
}

const sortByTime = (rows: LogRow[]): LogRow[] =>
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

/**
 * Interleave several machines' rows into one stream, newest `limit` kept.
 *
 * Sort is by timestamp only; `Array.sort` is stable, so rows sharing a timestamp keep the order of
 * the sources as given — a deterministic result rather than an arbitrary one.
 */
export function mergeFleetLog(sources: { rows: LogRow[] }[], limit: number): LogRow[] {
  const all: LogRow[] = [];
  for (const s of sources) for (const row of s.rows) all.push(row);
  sortByTime(all);
  return limit > 0 ? all.slice(-limit) : all;
}

const ARROW: Record<LogRow['kind'], string> = { chat: '→', sent: '⇢' };

/** One human line. `machineWidth` aligns the machine column across a merged view (0 = no column,
 *  used for a single-machine log where the column would be noise). */
export function fmtRow(r: LogRow, machineWidth = 0): string {
  const t = r.ts.replace('T', ' ').slice(0, 19);
  const col = machineWidth > 0 ? `${r.machine.padEnd(machineWidth)} ` : '';
  const task = r.task === null || r.task === '' ? '' : ` (task: ${r.task})`;
  const note = r.note === '' ? '' : `   [${r.note}]`;
  return `[${t}] ${col}${r.from} ${ARROW[r.kind]} ${r.to}${task}: ${r.body}${note}`;
}

/** Column width for the machine labels actually present (so a single-machine log stays clean). */
export const machineColumnWidth = (machines: LogMachine[]): number =>
  machines.length <= 1 ? 0 : Math.max(...machines.map((s) => s.machine.length));
