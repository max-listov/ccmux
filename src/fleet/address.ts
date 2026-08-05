import { RC_PREFIX_RE, SESSION_NAME_RE } from "../config/schema.ts";
import type { MachineConfig } from "../types.ts";

/**
 * A fleet address — `<machine>:<session>` — is the missing piece that made cross-machine work
 * unsafe: a session name alone is only meaningful on ONE machine, so an agent told to reply to
 * "api" from another box resolved it to a local same-named session and reported to a stranger
 * (incident 2026-08-05). The machine label is the `rcPrefix` we already have, so nothing new has to
 * be invented or kept in sync.
 *
 * A bare `<session>` (no colon) still means "on this machine" — existing behaviour, unchanged.
 * `:` is reserved for this by tightening the session-name regex (it was never usable in a name
 * anyway: tmux splits targets on `:`, so such a session could never be captured or sent to).
 */
export interface FleetAddress {
  machine: string | null; // null = local
  session: string;
}

/** Pure parse. `dev:api` → remote; `api` → local. Never throws — malformed input is reported. */
export function parseAddress(token: string): FleetAddress | { error: string } {
  const i = token.indexOf(":");
  if (i === -1) return { machine: null, session: token };
  const machine = token.slice(0, i);
  const session = token.slice(i + 1);
  if (machine === "") return { error: `bad address '${token}': missing machine before ':'` };
  if (session === "") return { error: `bad address '${token}': missing session after ':'` };
  if (session.includes(":")) return { error: `bad address '${token}': only one ':' allowed` };
  return { machine, session };
}

export const isAddressError = (a: FleetAddress | { error: string }): a is { error: string } => "error" in a;

/** Where an address should execute: locally, or over ssh to some host. Resolving the machine label
 *  against THIS machine's own `rcPrefix` first is a correctness requirement, not an optimisation —
 *  ssh to our own host would land in the PROD instance, not in an isolated dev one (its config,
 *  registry and tmux socket come from env that ssh does not carry). */
export type Route = { kind: "local"; session: string } | { kind: "remote"; alias: string; machine: string; session: string } | { kind: "error"; message: string };

export function routeFor(token: string, m: MachineConfig): Route {
  const addr = parseAddress(token);
  if (isAddressError(addr)) return { kind: "error", message: addr.error };
  if (addr.machine === null || addr.machine === m.rcPrefix) return { kind: "local", session: addr.session };
  const fleet = m.fleet;
  if (fleet === undefined || Object.keys(fleet).length === 0) {
    return {
      kind: "error",
      message: `fleet addressing is not configured on this machine — add a "fleet" map to machine.json (e.g. {"${addr.machine}": "<ssh-alias>"})`,
    };
  }
  // `Object.hasOwn`, not a plain lookup: `toString:api` would otherwise resolve to a prototype
  // METHOD, get stringified into argv, and fail as "transport failed" instead of "unknown machine".
  const alias = Object.hasOwn(fleet, addr.machine) ? fleet[addr.machine] : undefined;
  if (alias === undefined) {
    return { kind: "error", message: `unknown machine '${addr.machine}' — known: ${Object.keys(fleet).sort().join(", ")}` };
  }
  return { kind: "remote", alias, machine: addr.machine, session: addr.session };
}

/** This machine's own fleet address for a session — what a peer must use to reply to us. */
export const selfAddress = (m: MachineConfig, session: string): string => `${m.rcPrefix}:${session}`;

/**
 * Validate the origin label our ssh transport attaches to a forwarded message.
 *
 * **What this is NOT: authentication.** The trust boundary is ssh access, exactly as before — anyone
 * who can run a command on this box can already send as `cli`, which every agent prompt reads as the
 * human side. The origin only says *where a message came from*, so the recipient can reply to the
 * right machine instead of guessing.
 *
 * What it must therefore guarantee is that the LABEL cannot lie about its own shape, because it is
 * rendered ahead of the message body in the injected `[chat from …]` tag. Both halves are pinned to
 * their existing charsets: an unvalidated machine half let a caller pass
 * `owner] <text> [ignore` and forge an unprefixed `[chat from owner]` — a promotion to human
 * authority straight out of a routing hint (found in review, reproduced before this fix).
 *
 * `owner` stays reserved as a session part: ccmux uses it as the human's out-of-band identity and
 * relays it via `--on-behalf-of`. `cli` is deliberately ALLOWED — a shell on another fleet machine
 * is exactly as authoritative as a shell on this one, and labelling it `host-a:cli` tells the
 * recipient more than dropping the machine entirely did.
 */
export function parseOrigin(originArg: string, fromSession: boolean, reserved: readonly string[]): { machine: string; session: string } | { error: string } {
  if (fromSession) return { error: "msg: origin is transport-only (it cannot be set from inside a session)" };
  const bad = (why: string): { error: string } => ({ error: `msg: bad origin '${originArg}' — ${why}` });
  const addr = parseAddress(originArg);
  if (isAddressError(addr)) return bad("expected <machine>:<session>");
  if (addr.machine === null) return bad("expected <machine>:<session>");
  if (!RC_PREFIX_RE.test(addr.machine)) return bad("machine must be a lowercase slug (an rcPrefix)");
  if (!SESSION_NAME_RE.test(addr.session)) return bad("session part is not a legal session name");
  if (reserved.includes(addr.session)) {
    return bad(`'${addr.session}' is not a valid origin (it means "the human" to every agent)`);
  }
  return { machine: addr.machine, session: addr.session };
}
