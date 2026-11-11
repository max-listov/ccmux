import { z } from 'zod';
import type { LogMachine, LogPayload, LogRow } from '../chat/feedSchema.ts';
import { LogPayloadSchema, LogRowSchema } from '../chat/feedSchema.ts';
import { localRows, mergeFleetLog } from '../chat/fleetLog.ts';
import { loadLedger } from '../chat/ledger.ts';
import type { MachineConfig } from '../types.ts';
import { loadOutboxAcked } from './flush.ts';
import { loadOutbox } from './outbox.ts';
import { loadPeerHeld, PackedSchema, unpack } from './peerDelta.ts';
import { peersOf, remoteFailureCause, runPeer } from './transport.ts';

/** The chat log of this machine, or of the fleet — what `ccmux chat log --json` prints. */

interface Source {
  machine: LogMachine;
  rows: LogRow[];
}

/** What we require of a peer's answer before looking at individual rows: just "it has its rows,
 *  packed by change". Everything stricter is applied per row, so one bad line is not a lost machine. */
const RemoteEnvelopeSchema = z.object({ rows: PackedSchema });

/** The marker the remote transport puts on an answer it had to cut at its stream cap. */
const TRUNCATION_MARKER = 'output truncated';

/**
 * Why a peer's answer could not be read.
 *
 * A cut document and an old build produce the same `JSON.parse` failure and are nothing alike: one
 * is fixed by asking for less, the other by upgrading a machine. Saying "older ccmux?" about a
 * message that was simply too long sends the reader to the wrong place entirely — and this snapshot
 * serialises whole message bodies, so it is the failure that actually happens.
 */
export function unreadableReason(stdout: string, stderr: string): string {
  if (stderr.includes(TRUNCATION_MARKER)) {
    return `answer was cut at the transport's cap (${stdout.length} bytes arrived) — ask for fewer rows with -n, or follow the feed instead: ccmux chat log --follow`;
  }
  // A cut answer that carried no marker still betrays itself: it is large AND it does not close.
  const looksCut = stdout.length > 64 * 1024 && !stdout.trimEnd().endsWith('}');
  if (looksCut) {
    return `answer arrived incomplete (${stdout.length} bytes, no closing brace) — ask for fewer rows with -n, or follow the feed instead: ccmux chat log --follow`;
  }
  return 'unreadable log output (older ccmux?)';
}

/** Ask every OTHER machine for its own log. The remote call deliberately omits `--fleet`, so the
 *  recursion is impossible by construction rather than by a guard. An unreachable machine is a row,
 *  not a failure: with no server-to-server keys, transit exists only while the owner is connected.
 *
 *  Asked through `runPeer`, so a machine reachable only over the remote transport is asked at all. Reading the
 *  ssh map directly meant a remote-only peer was not unreachable in the view — it was ABSENT from it,
 *  which reads as a machine where nothing has ever happened. */
async function remoteLogs(m: MachineConfig, limit: number): Promise<Source[]> {
  const others = peersOf(m).filter((p) => p.machine !== m.rcPrefix);
  return Promise.all(
    others.map(async ({ machine, alias }): Promise<Source> => {
      const fail = (error: string): Source => ({
        machine: { machine, ok: false, error },
        rows: [],
      });
      // Asked by change, like the fleet's session list: a row this reader holds comes back as its
      // digest, and a log thirty letters deep is otherwise re-sent whole on every read.
      const held = loadPeerHeld(machine, 'chat-log');
      const r = await runPeer(
        m,
        machine,
        alias,
        ['ccmux', '_peer-read', 'chat-log', '-n', String(limit), ...held.knownArgs],
        { timeoutMs: 20_000 },
      );
      if (r.transportFailed) return fail(r.failureDetail ?? 'unreachable (no transit right now)');
      if (r.code !== 0)
        return fail(
          `remote ccmux failed (exit ${r.code}): ${remoteFailureCause(r.stderr) ?? 'no reason reported'}`,
        );
      try {
        const envelope = RemoteEnvelopeSchema.safeParse(JSON.parse(r.stdout)).data;
        const received = envelope === undefined ? null : unpack(envelope.rows, held.rows);
        if (envelope === undefined || received === null)
          return fail(unreadableReason(r.stdout, r.stderr));
        held.save([envelope.rows]);
        // Row-by-row, so ONE malformed line from a peer costs that line and not the peer's whole
        // history — the same leniency the local ledger loader already applies to its own file.
        // Trust OUR label for the machine, not the peer's self-report: the merged view exists to be
        // copied into an address, and the address that works is the one from this machine's map.
        const rows = received.flatMap((row) => {
          const parsedRow = LogRowSchema.safeParse({ ...(row as object), machine }).data;
          return parsedRow === undefined ? [] : [parsedRow];
        });
        return { machine: { machine, ok: true, error: null }, rows };
      } catch {
        return fail(unreadableReason(r.stdout, r.stderr));
      }
    }),
  );
}

/**
 * Both halves of the exchange: what arrived (ledger) AND what was sent elsewhere (outbox) — the
 * initiator's side is exactly what was missing when a hand-off went to the wrong machine. With
 * `fleet`, merged with every other machine's log in time order; a peer is asked WITHOUT it, so
 * answering about ourselves here is what makes the remote format the same shape as the printed one.
 */
export async function chatLogAnswer(
  m: MachineConfig,
  options: { limit: number; fleet: boolean },
): Promise<LogPayload> {
  const self: Source = {
    machine: { machine: m.rcPrefix, ok: true, error: null },
    rows: localRows(m.rcPrefix, loadLedger(m), loadOutbox(m), loadOutboxAcked(m)),
  };
  const sources = options.fleet ? [self, ...(await remoteLogs(m, options.limit))] : [self];
  // Emitted THROUGH the schema, so the shape a peer parses and the shape that is printed are one
  // definition rather than two that can drift.
  return LogPayloadSchema.parse({
    machines: sources.map((source) => source.machine),
    rows: mergeFleetLog(sources, options.limit),
  });
}
