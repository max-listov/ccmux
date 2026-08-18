import { run, runWithInput } from "../util/spawn.ts";
import { z } from "zod";
import { shellJoin } from "../util/shellQuote.ts";
import type { MachineConfig } from "../types.ts";
import { isWirePeer, runWire, wirePeers } from "./wire.ts";

/**
 * Run a ccmux command on another fleet machine over ssh.
 *
 * Transport choices, each forced by a real hazard:
 *  - **`BatchMode=yes`** — without it ssh sits on a password prompt against a pipe and hangs forever
 *    when the forwarded agent is gone (the normal state between the owner's sessions).
 *  - **`ConnectTimeout` + a hard kill deadline** — server→server transit exists only while the owner
 *    is connected (no server-side keys, by design), so a blackholed route must fail honestly instead
 *    of wedging the caller. ssh's own failures surface as exit 255, which never collides with
 *    ccmux's own 0/1/2.
 *  - **argv is shell-quoted** (`shellJoin`) — everything after the alias is source for the REMOTE
 *    shell, and session names legally contain `;`/`$`/backticks.
 *  - **the message body travels on stdin**, never in the command line: `ccmux msg` already reads a
 *    body from a pipe, so arbitrary quotes/newlines/`$` in the text can't corrupt or inject.
 *  - **both streams are relayed** — ccmux prints its own errors ("no such session") to stdout, so a
 *    wrapper that forwarded only stderr would swallow the real reason and show a bare exit code.
 */
//  - **`ControlMaster=no`** — if this ssh became the multiplex MASTER (a common `~/.ssh/config` has
//    `ControlMaster auto` + `ControlPersist`), the backgrounded master would inherit our stdout/stderr
//    and the pipe would never see EOF: every cold connection would hang until the kill deadline. `no`
//    still REUSES an existing master (fast path kept), it just never becomes one.
const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ControlMaster=no",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];
const SSH_EXIT_TRANSPORT = 255;

export interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The transport failed (unreachable / no transit / refused / timed out) — not the remote
   *  command's verdict. */
  transportFailed: boolean;
  /** What actually went wrong, when the transport can say. ssh cannot distinguish "no route" from
   *  "no agent forwarding", so it leaves this unset and the generic sentence stands; the wire knows
   *  the difference between offline, denied and timed out, and saying "ssh unreachable" for a
   *  policy refusal would send the reader looking for a network problem that does not exist. */
  failureDetail?: string;
}

export async function runRemote(
  alias: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<RemoteResult> {
  const cmd = shellJoin(argv);
  const full = ["ssh", ...SSH_OPTS, alias, cmd];
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const r = opts?.stdin !== undefined ? await runWithInput(full, opts.stdin, { timeoutMs }) : await run(full, { timeoutMs });
  const transportFailed = r.timedOut === true || r.code === SSH_EXIT_TRANSPORT;
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, transportFailed };
}

/** Relay a remote run to this process's own output and exit code — byte-exact stdout, so JSON
 *  consumers (`transcript --json`) are unaffected. A transport failure is named as such, never
 *  disguised as "no such session"; `writes` keeps the wording honest, since "nothing was sent" is
 *  meaningless for a read-only verb. */
export function relay(r: RemoteResult, what: string, writes = true): number {
  if (r.transportFailed) {
    const tail = writes ? " — nothing was sent" : "";
    const cause = r.failureDetail ?? "ssh unreachable, timed out, or no agent forwarding";
    console.error(`${what}: transport failed (${cause})${tail}`);
    if (r.stderr.trim() !== "") console.error(r.stderr.trimEnd());
    return 1;
  }
  if (r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== "") process.stderr.write(r.stderr);
  return r.code;
}

/**
 * Verify each fleet entry points at the machine it CLAIMS to. A stale or mistyped alias produces the
 * worst possible outcome — a correctly-addressed message delivered to the wrong box, with exit 0 —
 * which is precisely the failure class fleet addressing exists to remove. `ccmux list --json` already
 * reports the remote's own `rcPrefix`, so one cheap call per entry proves (or disproves) the map.
 * Unreachable is NOT a failure here: with no server-side keys, transit only exists while the owner
 * is connected, so "unreachable" is the normal state on a server.
 */
const ReportedPrefixSchema = z.object({ rcPrefix: z.string() });

/**
 * The one place that decides HOW a remote call travels.
 *
 * Every caller states WHERE (a machine label); this states WITH WHAT. Keeping the choice here means
 * a direction can move onto the wire by editing config, and no command has to learn that two
 * transports exist.
 */
export function runPeer(
  m: MachineConfig,
  machine: string,
  alias: string | null,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<RemoteResult> {
  if (isWirePeer(m, machine)) return runWire(m, machine, argv, opts);
  if (alias === null) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "",
      transportFailed: true,
      failureDetail: `no route to '${machine}': it is in neither the ssh fleet map nor wire.peers`,
    });
  }
  return runRemote(alias, argv, opts);
}

/** Every machine this box can address, and how it would get there. */
export interface Peer {
  machine: string;
  via: "ssh" | "wire";
  /** ssh alias, or null for a wire-only peer — a laptop has no alias anywhere. */
  alias: string | null;
}

export function peersOf(m: MachineConfig): Peer[] {
  const out = new Map<string, Peer>();
  for (const [machine, alias] of Object.entries(m.fleet ?? {})) {
    if (machine !== m.rcPrefix) out.set(machine, { machine, via: "ssh", alias });
  }
  // The wire wins where both are configured: that is what makes listing one machine a per-direction
  // switch rather than a fleet-wide migration.
  for (const machine of wirePeers(m)) {
    out.set(machine, { machine, via: "wire", alias: out.get(machine)?.alias ?? null });
  }
  return [...out.values()].sort((a, b) => a.machine.localeCompare(b.machine));
}

export interface FleetCheck {
  machine: string;
  via: "ssh" | "wire";
  alias: string | null;
  ok: boolean;
  reachable: boolean;
  reported: string | null;
  detail: string;
}

export async function checkFleet(m: MachineConfig): Promise<FleetCheck[]> {
  return Promise.all(
    peersOf(m).map(async ({ machine, alias, via }): Promise<FleetCheck> => {
      const r = await runPeer(m, machine, alias, ["ccmux", "list", "--json"], { timeoutMs: 15_000 });
      if (r.transportFailed) {
        return { machine, via, alias, ok: false, reachable: false, reported: null, detail: r.failureDetail ?? "unreachable (no transit right now — normal unless the owner is connected)" };
      }
      if (r.code !== 0) {
        return { machine, via, alias, ok: false, reachable: true, reported: null, detail: `remote ccmux failed (exit ${r.code}) — is ccmux on the non-interactive PATH there?` };
      }
      // Lenient on purpose: the far side may run an older ccmux whose `list --json` has a different
      // shape. We only need one field, so parse for exactly that instead of the strict full schema.
      let reported: string | null = null;
      try {
        reported = ReportedPrefixSchema.safeParse(JSON.parse(r.stdout)).data?.rcPrefix ?? null;
      } catch {
        reported = null;
      }
      if (reported === null) return { machine, via, alias, ok: false, reachable: true, reported, detail: "remote did not report an rcPrefix (older ccmux?)" };
      if (reported !== machine) {
        return { machine, via, alias, ok: false, reachable: true, reported, detail: `MISMATCH — this route really reaches '${reported}', so mail addressed to '${machine}:' would land on the wrong machine` };
      }
      return { machine, via, alias, ok: true, reachable: true, reported, detail: "ok" };
    }),
  );
}
