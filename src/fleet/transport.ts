import { run, runWithInput } from "../util/spawn.ts";
import { z } from "zod";
import { shellJoin } from "../util/shellQuote.ts";

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
  /** ssh itself failed (unreachable / no transit / timed out) — not the remote command's verdict. */
  transportFailed: boolean;
}

/**
 * Extra values handed to the remote as ENVIRONMENT, not as flags.
 *
 * This is a compatibility-safety choice, not a style one: a machine still on an older ccmux pushes
 * an unknown `--flag` into the message POSITIONALS, so the flag text becomes the body and the real
 * body (which travels on stdin) is never read — a silently corrupted message, delivered with exit 0.
 * Reproduced against the released parser before choosing this. An unknown environment variable is
 * simply ignored by any version, so the worst case degrades to "no machine label" — i.e. exactly
 * today's behaviour — instead of destroying the message.
 */
export async function runRemote(
  alias: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<RemoteResult> {
  const assigns = Object.entries(opts?.env ?? {}).map(([k, v]) => `${k}=${shellJoin([v])}`);
  const cmd = [...assigns, shellJoin(argv)].join(" ");
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
    console.error(`${what}: transport failed (ssh unreachable, timed out, or no agent forwarding)${tail}`);
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

export interface FleetCheck {
  machine: string;
  alias: string;
  ok: boolean;
  reachable: boolean;
  reported: string | null;
  detail: string;
}

export async function checkFleet(fleet: Record<string, string>): Promise<FleetCheck[]> {
  const entries = Object.entries(fleet);
  return Promise.all(
    entries.map(async ([machine, alias]): Promise<FleetCheck> => {
      const r = await runRemote(alias, ["ccmux", "list", "--json"], { timeoutMs: 15_000 });
      if (r.transportFailed) {
        return { machine, alias, ok: false, reachable: false, reported: null, detail: "unreachable (no transit right now — normal unless the owner is connected)" };
      }
      if (r.code !== 0) {
        return { machine, alias, ok: false, reachable: true, reported: null, detail: `remote ccmux failed (exit ${r.code}) — is ccmux on the non-interactive PATH there?` };
      }
      // Lenient on purpose: the far side may run an older ccmux whose `list --json` has a different
      // shape. We only need one field, so parse for exactly that instead of the strict full schema.
      let reported: string | null = null;
      try {
        reported = ReportedPrefixSchema.safeParse(JSON.parse(r.stdout)).data?.rcPrefix ?? null;
      } catch {
        reported = null;
      }
      if (reported === null) return { machine, alias, ok: false, reachable: true, reported, detail: "remote did not report an rcPrefix (older ccmux?)" };
      if (reported !== machine) {
        return { machine, alias, ok: false, reachable: true, reported, detail: `MISMATCH — this alias is really '${reported}', so mail addressed to '${machine}:' would land on the wrong machine` };
      }
      return { machine, alias, ok: true, reachable: true, reported, detail: "ok" };
    }),
  );
}
