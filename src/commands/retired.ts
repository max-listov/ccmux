/**
 * Public syntax we removed, and what replaced it.
 *
 * Removing a command is cheap; removing one we TAUGHT is not. The injected prompt handed agents
 * `restart <name> --then "<note>"` for months, and rules in other repositories still do. When the
 * flag went, the argument parser answered every unexpected token with the same generic `usage:`
 * line — which cannot distinguish "you typed it wrong" from "this no longer exists, use that".
 *
 * A session read that line as a VERSION problem ("this build doesn't support it") and went off to
 * build a workaround instead of using the replacement. The reasoning error was its own — the tool is
 * reality, a rule is only somebody's past intention — but the misleading answer was ours. An
 * out-of-date rule in a foreign repository gets fixed some day; this refusal is seen every time.
 *
 * So this is a table rather than one special case: the next removal is a row, and the check lives at
 * the dispatcher so a new command cannot forget it.
 */
export type RetiredSyntax = {
  /** The verb it belonged to — scoping keeps free text (a `msg` body) from ever matching. */
  verb: string;
  /** The exact argument token, matched whole; a substring inside prose is not a use of the flag. */
  token: string;
  /** Version that removed it, so "is my build old?" is answered before it is asked. */
  removedIn: string;
  /** What to run instead, ready to copy. */
  replacement: string;
  /** Why it went. A replacement without a reason invites someone to ask for it back. */
  why: string;
};

export const RETIRED: readonly RetiredSyntax[] = [
  {
    verb: "restart",
    token: "--then",
    removedIn: "0.12.0",
    replacement: 'ccmux msg <name> "<note>"',
    why:
      "a hand-off has to be recorded. A note carried by a restart flag has no sender, no reply " +
      "address and no entry in the chat ledger, so nobody could see it was sent or answer it",
  },
];

/**
 * The notice for a retired token in this invocation, or null when there is nothing to say. Pure:
 * argv in, text out. Matching is whole-token and verb-scoped — `ccmux msg x "mentions --then"` is
 * ordinary text and must pass straight through.
 */
export function retiredNotice(verb: string | undefined, args: readonly string[]): string | null {
  if (verb === undefined) return null;
  const hit = RETIRED.find((r) => r.verb === verb && args.includes(r.token));
  if (hit === undefined) return null;
  return [
    `'${hit.verb} ${hit.token}' was removed in ccmux ${hit.removedIn} — this is not an old build.`,
    `  use instead:  ${hit.replacement}`,
    `  why:          ${hit.why}.`,
    "  If a rule or prompt still tells you to use it, that rule is out of date — the tool is the current answer.",
  ].join("\n");
}
