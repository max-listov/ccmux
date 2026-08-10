import { z } from "zod";
import type { ChatMessage } from "../types.ts";
import type { Outbound } from "../fleet/outbox.ts";
import { outboundId, outboundTimestamp } from "../fleet/outbox.ts";
import { principalLabel, targetLabel } from "./identity.ts";

/**
 * One chronological view of a conversation that physically lives in several files on several
 * machines.
 *
 * This is the piece that was missing when a mis-addressed report cost hours (incident 2026-08-05):
 * each machine's ledger is its own little world, so reconstructing "who asked whom, and what came
 * back" meant walking two boxes by hand and eyeballing timestamps. Here both halves — what we SENT
 * (outbox) and what ARRIVED (ledger) — become rows of the same stream.
 *
 * Rows are ordered by their own machine's clock, so a merged view is only as aligned as the fleet's
 * clocks are. That is fine for reading a story ("ask, then reply") and deliberately NOT presented as
 * a causal order: nothing downstream depends on this ordering, it is a human-facing view.
 */
export const LogRowSchema = z.object({
  machine: z.string(), // whose log this row came from — carried ON the row so a merged stream is self-describing
  ts: z.string(),
  // chat         — landed in THIS machine's ledger (received, or sent to a local peer)
  // sent         — WE sent it to another machine (outbox)
  kind: z.enum(["chat", "sent"]),
  from: z.string(),
  to: z.string(),
  task: z.string().nullable().default(null),
  body: z.string(),
  note: z.string().default(""), // e.g. why an outgoing message never left
});
export type LogRow = z.infer<typeof LogRowSchema>;

/** Which machines the rows came from, and which could not be reached. Always present, so a consumer
 *  can tell "nothing happened there" from "we could not look". */
export const LogMachineSchema = z.object({
  machine: z.string(),
  ok: z.boolean().default(true),
  error: z.string().nullable().default(null),
});
export type LogMachine = z.infer<typeof LogMachineSchema>;

/**
 * The `--json` payload — ONE shape whether you asked about this machine or the whole fleet, so a
 * consumer never has to branch on which flag was used. It is also the wire format `--fleet` reads
 * from a peer (a peer is always asked without `--fleet`, so it answers about itself).
 *
 * Parsed LENIENTLY from a remote: another box may run an older ccmux, and a partly-readable log
 * beats refusing to show anything.
 */
export const LogPayloadSchema = z.object({
  machines: z.array(LogMachineSchema).default([]),
  rows: z.array(LogRowSchema).default([]),
});
export type LogPayload = z.infer<typeof LogPayloadSchema>;

/** Ledger + outbox of ONE machine as a single row list, oldest first. Pure. */
export function localRows(machine: string, ledger: ChatMessage[], outbox: Outbound[], settled: ReadonlySet<string> = new Set()): LogRow[] {
  const rows: LogRow[] = [];
  for (const msg of ledger) {
    rows.push({
      machine,
      ts: msg.ts,
      kind: "chat",
      // A remote sender is shown with its machine, because that is the only rendering from which a
      // full pinned source can be read directly — no cwd/name inference is needed.
      from: principalLabel(msg.from),
      to: targetLabel(msg.to),
      task: msg.task,
      body: msg.body,
      note: "",
    });
  }
  for (const o of outbox) {
    rows.push({
      machine,
      ts: outboundTimestamp(o),
      kind: "sent",
      from: principalLabel(o.envelope.from),
      to: targetLabel(o.envelope.to),
      task: o.envelope.task,
      body: o.envelope.body,
      // A failed send that the daemon later drained is no longer bad news — saying otherwise would
      // send someone chasing a message that did arrive.
      note: o.result.ok ? "" : settled.has(outboundId(o)) ? "sent later, on retry" : `NOT SENT — ${o.result.detail === "" ? "unknown error" : o.result.detail}`,
    });
  }
  return sortByTime(rows);
}

const sortByTime = (rows: LogRow[]): LogRow[] => rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

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

const ARROW: Record<LogRow["kind"], string> = { chat: "→", sent: "⇢" };

/** One human line. `machineWidth` aligns the machine column across a merged view (0 = no column,
 *  used for a single-machine log where the column would be noise). */
export function fmtRow(r: LogRow, machineWidth = 0): string {
  const t = r.ts.replace("T", " ").slice(0, 19);
  const col = machineWidth > 0 ? `${r.machine.padEnd(machineWidth)} ` : "";
  const task = r.task === null || r.task === "" ? "" : ` (task: ${r.task})`;
  const note = r.note === "" ? "" : `   [${r.note}]`;
  return `[${t}] ${col}${r.from} ${ARROW[r.kind]} ${r.to}${task}: ${r.body}${note}`;
}

/** Column width for the machine labels actually present (so a single-machine log stays clean). */
export const machineColumnWidth = (machines: LogMachine[]): number =>
  machines.length <= 1 ? 0 : Math.max(...machines.map((s) => s.machine.length));
