import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { appendMessage, loadLedger } from "../chat/store.ts";
import { buildEnvelope } from "../chat/compose.ts";
import { cliPrincipal, externalAddress, managedPeer, ownerTarget, principalLabel, targetLabel } from "../chat/identity.ts";
import { externalNameOf, isExternalToken, lookupExternal, outstandingExternal } from "../chat/external.ts";
import { usageLine } from "./help.ts";
import { preview } from "../util/preview.ts";
import { log } from "../util/log.ts";
import type { ChatTarget } from "../types.ts";

/**
 * `ccmux relay owner/<name> "<their answer>"` — bring an answer back from outside the fleet.
 *
 * This is the half that makes the outward address more than a note to self. Without a way to record
 * what came back, "awaiting a reply" is a list that only grows, and a list that only grows is one
 * nobody reads.
 *
 * The answer is recorded as a RELAY, not as the external party speaking. `onBehalfOf` already exists
 * for exactly this shape — "who the instruction truly came from when `from` is only the courier" —
 * so the sender sees *on behalf of owner/<name>* while `from` stays whoever actually typed it.
 * Nothing gains the ability to impersonate a party ccmux cannot authenticate, which it could never
 * do honestly: the evidence that these words are theirs is a person's word, and the record says so.
 */
export async function cmdRelay(args: string[]): Promise<number> {
  let task: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--task") task = args[++i] ?? null;
    else if (value?.startsWith("--")) return console.error(`relay: unknown flag '${value}'\n${usageLine("relay")}`), 1;
    else if (value !== undefined) positionals.push(value);
  }

  const token = positionals[0];
  let body = positionals.slice(1).join(" ").trim();
  if (body === "" && token !== undefined && !process.stdin.isTTY) body = (await Bun.stdin.text()).trim();
  if (token === undefined || body === "") return console.error(usageLine("relay")), 1;
  if (!isExternalToken(token)) {
    return console.error(`relay: '${token}' is not an owner outside the fleet — those are addressed as owner/<name>. A managed session answers for itself with: ccmux msg <machine>:<session>`), 1;
  }

  const m = loadMachineConfig();
  const external = lookupExternal(m, token);
  if ("error" in external) return console.error(`relay: ${external.error}`), 1;

  const ledger = loadLedger(m);
  // The letter this answers, oldest first — an answer belongs to the one that has waited longest.
  const waiting = outstandingExternal(ledger).filter((l) => l.name === external.name && (task === null || l.msg.task === task));
  const letter = waiting[0];
  if (letter === undefined) {
    // Refused rather than recorded loose. An answer with no letter has nobody to be delivered to,
    // and filing it anyway would make the outstanding list disagree with itself.
    const others = outstandingExternal(ledger).filter((l) => l.name === external.name);
    const hint = others.length === 0
      ? `nothing is waiting on ${externalAddress(external.name)}`
      : `waiting on ${externalAddress(external.name)}: ${others.map((l) => l.msg.task ?? "(no task)").join(", ")} — name one with --task`;
    return console.error(`relay: no letter to answer — ${hint}`), 1;
  }

  // Back to whoever wrote. A shell has no pane to deliver into, so that answer goes to the owner,
  // who is the one person guaranteed to see it — the letter still closes either way.
  const origin = letter.msg.from;
  const target: ChatTarget = origin.kind === "managed"
    ? (() => {
        const session = findSession(loadSessions(m), origin.session);
        return session === undefined ? ownerTarget() : managedPeer(m.rcPrefix, session);
      })()
    : ownerTarget();

  const from = cliPrincipal(m.rcPrefix);
  appendMessage(
    m,
    buildEnvelope(from, target, body, { task: letter.msg.task, defer: false, onBehalfOf: externalAddress(external.name), notBefore: null }),
  );
  log.info({ msg: "external answer relayed", external: external.name, to: targetLabel(target), task: letter.msg.task });
  console.log(`relayed ${externalAddress(external.name)} → ${targetLabel(target)}: ${preview(body)}`);
  console.log(`closes the letter ${principalLabel(letter.msg.from)} sent ${letter.msg.ts}${letter.msg.task === null ? "" : ` (task ${letter.msg.task})`}`);
  return 0;
}

/** Letters this machine has sent outside the fleet and not heard back on. Printed by `inbox`,
 *  because that is where an agent asks what its correspondence is doing. */
export function outstandingLines(m: ReturnType<typeof loadMachineConfig>): string[] {
  const waiting = outstandingExternal(loadLedger(m));
  if (waiting.length === 0) return [];
  const now = Date.now();
  return [
    `waiting on ${waiting.length} answer(s) from outside the fleet:`,
    ...waiting.map((l) => {
      const age = Math.max(0, Math.round((now - Date.parse(l.msg.ts)) / 60_000));
      const task = l.msg.task === null ? "" : ` (task ${l.msg.task})`;
      return `  ${externalAddress(l.name)}${task} — ${age}m, from ${principalLabel(l.msg.from)}: ${preview(l.msg.body, 60)}`;
    }),
    `  record an answer: ccmux relay owner/<name> "<what they said>"`,
  ];
}

export { externalNameOf };
