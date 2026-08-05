import { loadMachineConfig } from "../config/machine.ts";
import { routeFor, selfAddress } from "./address.ts";
import { randomUUID } from "node:crypto";
import { runRemote, relay } from "./transport.ts";
import { appendOutbound } from "./outbox.ts";
import { CLI } from "../chat/store.ts";
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
}

export async function forwardIfRemote(target: string, verb: string, remoteArgs: string[], opts: ForwardOpts = {}): Promise<Forwarded> {
  const cfg = opts.m ?? loadMachineConfig();
  const route = routeFor(target, cfg);
  if (route.kind === "error") {
    console.error(route.message);
    return { done: true, code: 1 };
  }
  if (route.kind === "local") return { done: false, session: route.session, m: cfg };

  const from = process.env.CCMUX_SESSION ?? CLI;
  const thenIdx = remoteArgs.indexOf("--then");
  const note = thenIdx >= 0 ? (remoteArgs[thenIdx + 1] ?? "") : null;
  // A `--then` note is dispatched work that lands as plain text in the target's pane, which is
  // exactly how the incident's task arrived: anonymous, with a bare session name to "report back" to.
  // Stamping the initiator's full address on it is the same fix chat got — the target no longer has
  // to infer who asked or where to answer.
  const args = note === null ? remoteArgs : remoteArgs.map((a, i) => (i === thenIdx + 1 ? stampNote(note, selfAddress(cfg, from)) : a));

  const r = await runRemote(route.alias, ["ccmux", verb, route.session, ...args], opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
  // A cross-machine `restart --then` IS a hand-off, so it belongs in the outbox next to chat — same
  // reason: the initiator must have a record of what it asked for, including when transit failed.
  if (note !== null) {
    appendOutbound(cfg, {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from,
      toMachine: route.machine,
      toSession: route.session,
      kind: "restart-then",
      body: note,
      task: null,
      ok: !r.transportFailed && r.code === 0,
      detail: r.transportFailed ? "transport failed" : r.code === 0 ? "" : `remote exit ${r.code}`,
    });
  }
  const code = relay(r, `${verb} ${target}`, remoteWrites(verb));
  return { done: true, code };
}

/** Prefix a dispatched note with its origin + the exact way to answer it. */
export const stampNote = (note: string, origin: string): string =>
  `[from ${origin}] ${note}\n(reply with: ccmux msg ${origin} "<your reply>")`;

/** Does this verb CHANGE anything on the far side? Only then may a transport failure claim that
 *  "nothing was sent" — for a read (`wait`, `transcript`, `logs`) that phrasing is simply false. */
const WRITES = new Set(["msg", "restart", "start", "stop", "rm", "send", "mode", "chat", "router", "adopt"]);
const remoteWrites = (verb: string): boolean => WRITES.has(verb);
