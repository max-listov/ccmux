import { loadMachineConfig } from "../config/machine.ts";
import { setSessionChatEnabled } from "../config/sessions.ts";
import { loadLedger } from "../chat/store.ts";
import { loadOutbox } from "../fleet/outbox.ts";
import { localRows, mergeFleetLog, fmtRow, machineColumnWidth, LogRowSchema, LogPayloadSchema, type LogMachine, type LogRow } from "../chat/fleetLog.ts";
import { z } from "zod";
import { runRemote } from "../fleet/transport.ts";
import { log } from "../util/log.ts";
import type { MachineConfig } from "../types.ts";

const USAGE = "usage: ccmux chat <log [-n N] [--fleet] [--json] | on <name> | off <name>>";

interface Source {
  machine: LogMachine;
  rows: LogRow[];
}

/** What we require of a peer's answer before looking at individual rows: just "it has a rows list".
 *  Everything stricter is applied per row, so one bad line is not a lost machine. */
const RemoteEnvelopeSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())).default([]) });

/** Ask every OTHER machine for its own log. The remote call deliberately omits `--fleet`, so the
 *  recursion is impossible by construction rather than by a guard. An unreachable machine is a row,
 *  not a failure: with no server-to-server keys, transit exists only while the owner is connected. */
async function remoteLogs(m: MachineConfig, limit: number): Promise<Source[]> {
  const others = Object.entries(m.fleet ?? {}).filter(([machine]) => machine !== m.rcPrefix);
  return Promise.all(
    others.map(async ([machine, alias]): Promise<Source> => {
      const fail = (error: string): Source => ({ machine: { machine, ok: false, error }, rows: [] });
      const r = await runRemote(alias, ["ccmux", "chat", "log", "-n", String(limit), "--json"], { timeoutMs: 20_000 });
      if (r.transportFailed) return fail("unreachable (no transit right now)");
      if (r.code !== 0) return fail(`remote ccmux failed (exit ${r.code})`);
      try {
        const envelope = RemoteEnvelopeSchema.safeParse(JSON.parse(r.stdout)).data;
        if (envelope === undefined) return fail("unreadable log output (older ccmux?)");
        // Row-by-row, so ONE malformed line from a peer costs that line and not the peer's whole
        // history — the same leniency the local ledger loader already applies to its own file.
        // Trust OUR label for the machine, not the peer's self-report: the merged view exists to be
        // copied into an address, and the address that works is the one from this machine's map.
        const rows = envelope.rows.flatMap((row) => {
          const parsedRow = LogRowSchema.safeParse({ ...row, machine }).data;
          return parsedRow === undefined ? [] : [parsedRow];
        });
        return { machine: { machine, ok: true, error: null }, rows };
      } catch {
        return fail("unreadable log output (older ccmux?)");
      }
    }),
  );
}

async function cmdChatLog(m: MachineConfig, args: string[]): Promise<number> {
  const nIdx = args.indexOf("-n");
  const parsed = nIdx >= 0 ? Number.parseInt(args[nIdx + 1] ?? "", 10) : 30;
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  // Both halves of the exchange: what arrived (ledger) AND what we sent elsewhere (outbox) — the
  // initiator's side is exactly what was missing when a hand-off went to the wrong machine.
  const self: Source = {
    machine: { machine: m.rcPrefix, ok: true, error: null },
    rows: localRows(m.rcPrefix, loadLedger(m), loadOutbox(m)),
  };
  // A peer is always asked WITHOUT `--fleet` (see remoteLogs), so answering about ourselves here is
  // what makes the wire format the same shape as the human-facing one.
  const sources = args.includes("--fleet") ? [self, ...(await remoteLogs(m, limit))] : [self];
  const machines = sources.map((s) => s.machine);
  const rows = mergeFleetLog(sources, limit);

  if (args.includes("--json")) {
    // Emitted THROUGH the schema, so the shape a peer parses and the shape we print are one
    // definition rather than two that can drift.
    console.log(JSON.stringify(LogPayloadSchema.parse({ machines, rows })));
    return 0;
  }
  // Unreachable notices go to stderr so the row stream stays pipeable on stdout.
  for (const s of machines) if (!s.ok) console.error(`(${s.machine}: ${s.error})`);
  if (rows.length === 0) {
    console.log("(chat log empty)");
    return 0;
  }
  const width = machineColumnWidth(machines);
  for (const row of rows) console.log(fmtRow(row, width));
  return 0;
}

/**
 * Chat administration + inspection:
 *   ccmux chat log [-n N]    — this machine's exchange (received + sent), tail of N (default 30)
 *   ccmux chat log --fleet   — the same, merged with every other machine's log, in time order
 *   ccmux chat log --json    — machine-readable; also the wire format `--fleet` reads from peers
 *   ccmux chat on  <name>    — enable inter-agent chat for a session (default is OFF)
 *   ccmux chat off <name>    — disable it
 */
export async function cmdChat(args: string[]): Promise<number> {
  const sub = args[0];
  const m = loadMachineConfig();

  if (sub === "log") return cmdChatLog(m, args.slice(1));

  if (sub === "on" || sub === "off") {
    const name = args[1];
    if (name === undefined) {
      console.log(`usage: ccmux chat ${sub} <name>`);
      return 1;
    }
    const ok = await setSessionChatEnabled(m, name, sub === "on");
    if (!ok) {
      console.log(`no such session: ${name}`);
      return 1;
    }
    log.info({ msg: "chat toggled", name, enabled: sub === "on" });
    // Chat framing + the Stop hook are LAUNCH-time (see claude/launch.ts settingsArg) — so, like
    // `ccmux mode` and `ccmux router`, this only takes effect on the next restart. Saying so here is
    // the difference between "it works" and "I toggled it and nothing happened".
    console.log(`${name}: chat ${sub === "on" ? "enabled" : "disabled"} — applies on: ccmux restart ${name}`);
    if (sub === "on") {
      console.log(`  then: ccmux msg ${name} "…" --task <name>   ·   --defer waits for its turn to end`);
      console.log(`  restarting the whole fleet at once: ccmux restart --all`);
    }
    return 0;
  }

  console.log(USAGE);
  return sub === undefined ? 0 : 1;
}
