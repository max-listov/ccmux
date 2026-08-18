import { z } from "zod";
import { loadMachineConfig } from "../config/machine.ts";
import { collectRows } from "./list.ts";
import { peersOf, runPeer } from "../fleet/transport.ts";
import { VERSION } from "../util/version.ts";
import type { MachineConfig } from "../types.ts";

/**
 * `ccmux fleet` — every session on every machine of the fleet, in one view.
 *
 * Besides being the obvious "where is everything", this is what makes the homonym mine visible: you
 * see at a glance that `api` lives on host-a while host-b has its own similarly-named session, which
 * is precisely the confusion that mis-delivered a report in the 2026-08-05 incident.
 *
 * Deliberately LENIENT about what a remote returns: another box may run an older ccmux whose
 * `list --json` has a different shape, so we parse only the few fields we display. A missing agent
 * becomes explicit `unknown`; silently calling it Claude would turn version skew into misrouting.
 * And "unreachable" is a NORMAL result, not a failure — with no server-side keys, transit
 * between two servers only exists while the owner is connected — so the command still exits 0 and
 * simply marks that machine, instead of an agent reading routine degradation as an error.
 */
const RemoteSessionSchema = z.object({
  name: z.string(),
  agent: z.enum(["claude", "codex"]).nullable().default(null),
  state: z.string().default("?"),
  model: z.string().nullable().default(null),
  running: z.boolean().default(false),
  stale: z.array(z.string()).default([]),
  uptime: z.object({ text: z.string().nullable().default(null) }).partial().optional(),
});
const RemoteListSchema = z.object({
  version: z.string().default("?"),
  rcPrefix: z.string().default("?"),
  sessions: z.array(RemoteSessionSchema).default([]),
});

export interface FleetMachine {
  machine: string;
  alias: string | null; // null = this machine
  ok: boolean;
  error: string | null;
  version: string;
  sessions: z.infer<typeof RemoteSessionSchema>[];
}

/** Query every machine in parallel; each failure is contained to its own row. */
export async function collectFleet(m: MachineConfig): Promise<FleetMachine[]> {
  const local = await collectRows(m);
  const self: FleetMachine = {
    machine: m.rcPrefix,
    alias: null,
    ok: true,
    error: null,
    version: VERSION,
    sessions: local.map((r) => ({
      name: r.session.name,
      agent: r.session.agent,
      state: r.state,
      model: r.model,
      running: r.running,
      uptime: { text: r.uptimeText },
      stale: r.stale,
    })),
  };
  const remote = await Promise.all(
    peersOf(m).map(async ({ machine, alias, via }): Promise<FleetMachine> => {
      const r = await runPeer(m, machine, alias, ["ccmux", "list", "--json"], { timeoutMs: 20_000 });
      const label = via === "wire" ? "wire" : alias;
      if (r.transportFailed) {
        return { machine, alias: label, ok: false, error: r.failureDetail ?? "unreachable (no transit right now)", version: "?", sessions: [] };
      }
      if (r.code !== 0) return { machine, alias: label, ok: false, error: `remote ccmux failed (exit ${r.code})`, version: "?", sessions: [] };
      try {
        const parsed = RemoteListSchema.safeParse(JSON.parse(r.stdout)).data;
        if (parsed === undefined) return { machine, alias: label, ok: false, error: "unreadable list output (older ccmux?)", version: "?", sessions: [] };
        return { machine, alias: label, ok: true, error: null, version: parsed.version, sessions: parsed.sessions };
      } catch {
        return { machine, alias: label, ok: false, error: "unreadable list output (older ccmux?)", version: "?", sessions: [] };
      }
    }),
  );
  return [self, ...remote];
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function formatFleetSession(machine: string, session: z.infer<typeof RemoteSessionSchema>): string {
  const restart = session.stale.length > 0 ? `  ⟳ ${session.stale.join(",")}` : "";
  const agent = session.agent ?? "unknown";
  return `  ${pad(`${machine}:${session.name}`, 28)} ${pad(agent, 8)} ${pad(session.state, 9)} ${pad(session.model ?? "-", 11)} ${pad(session.uptime?.text ?? "", 7)}${restart}`;
}

export async function cmdFleet(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const machines = await collectFleet(m);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), machines }));
    return 0;
  }
  if (machines.length === 1) {
    console.log('(no peers configured in machine.json — add a "fleet" map or "wire.peers" — showing this machine only)');
  }
  for (const fm of machines) {
    const label = fm.alias === null ? `${fm.machine} (this machine)` : fm.alias === "wire" ? `${fm.machine} via wire` : `${fm.machine} → ${fm.alias}`;
    if (!fm.ok) {
      console.log(`${label}: ${fm.error}`);
      continue;
    }
    console.log(`${label}  [ccmux ${fm.version}]`);
    for (const s of fm.sessions) {
      // Full address on every line — the thing you copy into `ccmux msg` without guessing.
      // A session that a restart would change is flagged right here, so "who is still on the old
      // prompt" is readable across the fleet instead of remembered.
      console.log(formatFleetSession(fm.machine, s));
    }
  }
  return 0; // unreachable machines are routine, never a failure exit
}
