/**
 * Writing to a component owner who is not on this fleet.
 *
 * The route is a person, and that is the design rather than a shortcoming: one hop through a human
 * is cheaper than integrating with somebody else's product, and ccmux is not that product's
 * transport. What was missing is that the hop was **unwritten** — no record, no reply address, and
 * no way to ask what has not come back. So the hop stays, and everything around it is made real:
 *
 *  - the party has a name of its own, out of the session namespace it never belonged in;
 *  - the letter is appended to the ledger like any other, with a true `to`;
 *  - automatic delivery refuses and NAMES the route, instead of half-succeeding;
 *  - the mirror the owner already reads is what carries it — nothing new to configure;
 *  - and it is **awaiting a reply until one is recorded**, which is a default rather than a flag.
 *
 * The default is the part that decides whether any of this is used. A flag the sender has to
 * remember is a flag that is wrong within a week — the same trap as a role nobody updates. Waiting
 * for an answer is the norm here, not the exception: every task handed to an owner ends with "tell
 * me when it is done". So the answer to "what have I sent and not heard back on" comes from the
 * records themselves, and closing one is the deliberate act.
 */

import { EXTERNAL_PREFIX, externalAddress, samePrincipal } from "./identity.ts";
import type { LedgerSlot } from "./store.ts";
import type { ChatMessage, ChatPrincipal, MachineConfig } from "../types.ts";

export { EXTERNAL_PREFIX };

/** Is this token addressed to someone outside the fleet? */
export function isExternalToken(token: string): boolean {
  return token.startsWith(EXTERNAL_PREFIX) && token.length > EXTERNAL_PREFIX.length;
}

export function externalNameOf(token: string): string {
  return token.slice(EXTERNAL_PREFIX.length);
}

export type ExternalLookup = { name: string; where: string } | { error: string };

/**
 * Resolve `owner/<name>` against what this machine declares.
 *
 * An undeclared name is refused rather than invented. That refusal is the whole reason the namespace
 * exists: the failure being removed is a message that went somewhere real and wrong, so an address
 * that resolves to nothing must stop, not improvise.
 */
export function lookupExternal(m: MachineConfig, token: string): ExternalLookup {
  const name = externalNameOf(token);
  const where = m.externals[name];
  if (where !== undefined) return { name, where };
  const declared = Object.keys(m.externals).sort();
  const known = declared.length === 0
    ? `this machine declares none — add one under "externals" in machine.json: {"${name}": "where they work and how you reach them"}`
    : `declared here: ${declared.map(externalAddress).join(", ")}`;
  return { error: `no owner outside the fleet is declared as '${externalAddress(name)}' — ${known}` };
}

/** One letter sent outside the fleet, and whether an answer has been recorded for it. */
export interface OutstandingLetter {
  msg: ChatMessage;
  name: string;
}

/**
 * Letters to `owner/<name>` that nothing has answered yet.
 *
 * "Answered" is a record travelling the other way: a relayed message carrying `onBehalfOf` set to
 * that same address, addressed back to whoever wrote. The reply rides the ordinary relay path — a
 * human courier is exactly what `onBehalfOf` was built to represent — so no second identity has to
 * be invented, and nothing can claim to BE the external party.
 *
 * Scoped to one sender by default, because "what have I not heard back on" is a question each agent
 * asks about its own correspondence.
 */
export function outstandingExternal(ledger: readonly LedgerSlot[], from?: ChatPrincipal): OutstandingLetter[] {
  // COUNTED, not a set: two letters to the same owner want two answers, and a set would let one
  // reply close both — under-reporting exactly what this list exists to show. Oldest first, so an
  // answer closes the letter that has been waiting longest.
  const answers = new Map<string, number>();
  for (const msg of ledger) {
    if (msg === null || msg.onBehalfOf === null || !isExternalToken(msg.onBehalfOf)) continue;
    const key = `${externalNameOf(msg.onBehalfOf)}\u0000${msg.task ?? ""}`;
    answers.set(key, (answers.get(key) ?? 0) + 1);
  }
  const out: OutstandingLetter[] = [];
  for (const msg of ledger) {
    if (msg === null || msg.to.kind !== "external") continue;
    const key = `${msg.to.name}\u0000${msg.task ?? ""}`;
    const remaining = answers.get(key) ?? 0;
    if (remaining > 0) {
      answers.set(key, remaining - 1); // this letter is the one that answer belongs to
      continue;
    }
    if (from !== undefined && !samePrincipal(msg.from, from)) continue;
    out.push({ msg, name: msg.to.name });
  }
  return out;
}

/**
 * What the courier is handed.
 *
 * Deliberately one block with the address on it: the person carrying this has to paste it somewhere
 * else and bring an answer back, and a reply that cannot be attributed to the letter it answers is
 * how this became untracked in the first place.
 */
export function courierNote(name: string, where: string, body: string, task: string | null): string {
  const forTask = task === null ? "" : `\ntask: ${task}`;
  return (
    `To ${name} — outside the fleet, reached through you.\nwhere: ${where}${forTask}\n\n${body}\n\n` +
    `When they answer, record it so the sender is told and the letter stops waiting:\n` +
    `  ccmux relay ${externalAddress(name)}${task === null ? "" : ` --task ${task}`} "<their answer>"`
  );
}
