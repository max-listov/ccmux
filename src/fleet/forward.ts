import { loadMachineConfig } from "../config/machine.ts";
import { routeFor } from "./address.ts";
import { runPeer, relay } from "./transport.ts";
import type { MachineConfig } from "../types.ts";

/**
 * The one place a command decides "is this target on another machine?".
 *
 * Returns the LOCAL session name to keep going with, or a finished exit code when the work was
 * forwarded (or the address was bad). Commands call this at their own front door — deliberately not
 * in `cli.ts` dispatch, because `msg` must run its local authority gates BEFORE anything leaves the
 * machine, and a dispatch-level hook could not know that. It also can't be a blind "does any arg
 * contain a colon" scan: `--task api:build` is legal free text, and `msg`'s recipient isn't argv[0].
 */
export type Forwarded = { done: true; code: number } | { done: false; session: string; m: MachineConfig };

export interface ForwardOpts {
  m?: MachineConfig;
  /** Hard deadline for the remote call. MUST exceed what the remote verb may legitimately take:
   *  `wait` blocks for its own timeout, so the transport default (30s) would kill a healthy link and
   *  report "transport failed" for a worker that was simply still working. */
  timeoutMs?: number;
  /** Words that sit BETWEEN the verb and the session name — `chat on <name>`, `router off <name>`.
   *  Without this the sub-verb would be rebuilt as `chat <name> on`, which is a different command. */
  verbArgs?: string[];
}

export async function forwardIfRemote(target: string, verb: string, remoteArgs: string[], opts: ForwardOpts = {}): Promise<Forwarded> {
  const cfg = opts.m ?? loadMachineConfig();
  const route = routeFor(target, cfg);
  if (route.kind === "error") {
    console.error(route.message);
    return { done: true, code: 1 };
  }
  if (route.kind === "local") return { done: false, session: route.session, m: cfg };

  const args = remoteArgs;

  const argv = ["ccmux", verb, ...(opts.verbArgs ?? []), route.session, ...args];
  const r = await runPeer(cfg, route.machine, route.alias, argv, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
  const code = relay(r, `${verb} ${target}`, remoteWrites(verb));
  return { done: true, code };
}

/** Does this verb CHANGE anything on the far side? Only then may a transport failure claim that
 *  "nothing was sent" — for a read (`wait`, `transcript`, `logs`) that phrasing is simply false. */
const WRITES = new Set(["msg", "restart", "start", "stop", "rm", "send", "mode", "chat", "router", "adopt"]);
const remoteWrites = (verb: string): boolean => WRITES.has(verb);
