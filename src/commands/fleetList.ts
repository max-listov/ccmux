import { z } from "zod";
import { loadMachineConfig } from "../config/machine.ts";
import { collectRows } from "./list.ts";
import { runRemote } from "../fleet/transport.ts";
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
 * `list --json` has a different shape, so we parse only the few fields we display, defaulting the
 * rest. And "unreachable" is a NORMAL result, not a failure — with no server-side keys, transit
 * between two servers only exists while the owner is connected — so the command still exits 0 and
 * simply marks that machine, instead of an agent reading routine degradation as an error.
 */
const RemoteSessionSchema = z.object({
  name: z.string(),
  state: z.string().default("?"),
  model: z.string().nullable().default(null),
  running: z.boolean().default(false),
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
      state: r.state,
      model: r.model,
      running: r.running,
      uptime: { text: r.uptimeText },
    })),
  };
  const others = Object.entries(m.fleet ?? {}).filter(([machine]) => machine !== m.rcPrefix);
  const remote = await Promise.all(
    others.map(async ([machine, alias]): Promise<FleetMachine> => {
      const r = await runRemote(alias, ["ccmux", "list", "--json"], { timeoutMs: 20_000 });
      if (r.transportFailed) {
        return { machine, alias, ok: false, error: "unreachable (no transit right now)", version: "?", sessions: [] };
      }
      if (r.code !== 0) return { machine, alias, ok: false, error: `remote ccmux failed (exit ${r.code})`, version: "?", sessions: [] };
      try {
        const parsed = RemoteListSchema.safeParse(JSON.parse(r.stdout)).data;
        if (parsed === undefined) return { machine, alias, ok: false, error: "unreadable list output (older ccmux?)", version: "?", sessions: [] };
        return { machine, alias, ok: true, error: null, version: parsed.version, sessions: parsed.sessions };
      } catch {
        return { machine, alias, ok: false, error: "unreadable list output (older ccmux?)", version: "?", sessions: [] };
      }
    }),
  );
  return [self, ...remote];
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

export async function cmdFleet(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const machines = await collectFleet(m);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), machines }));
    return 0;
  }
  if (Object.keys(m.fleet ?? {}).length === 0) {
    console.log('(no "fleet" map in machine.json — showing this machine only)');
  }
  for (const fm of machines) {
    const label = fm.alias === null ? `${fm.machine} (this machine)` : `${fm.machine} → ${fm.alias}`;
    if (!fm.ok) {
      console.log(`${label}: ${fm.error}`);
      continue;
    }
    console.log(`${label}  [ccmux ${fm.version}]`);
    for (const s of fm.sessions) {
      // Full address on every line — the thing you copy into `ccmux msg` without guessing.
      console.log(`  ${pad(`${fm.machine}:${s.name}`, 28)} ${pad(s.state, 9)} ${pad(s.model ?? "-", 11)} ${s.uptime?.text ?? ""}`);
    }
  }
  return 0; // unreachable machines are routine, never a failure exit
}
