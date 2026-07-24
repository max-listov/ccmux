/**
 * In-code registry of named prompt MODULES that a session can carry (Session.promptModules). Each
 * is a builder resolved fresh at every launch and composed INTO the single injected system prompt
 * (see managePrompt.buildPrompt) — so the TEXT is versioned code, never persisted, and an update
 * reaches every session on its next restart with no drift. The registry key is the only thing the
 * registry stores. Add a capability = add an entry here (no schema change).
 */

export interface PromptModuleContext {
  name: string; // this session's name
  cli: string; // how to invoke ccmux (bare shim / absolute — see env.promptInvocation)
}

/**
 * ROUTER — the autonomous-manager protocol. A router relays owner-dictated follow-ups to the right
 * target session with `--defer` (so they arrive only at the target's turn boundary, never mid-work),
 * then waits for the reply, validates it, re-asks on a gap, and escalates to the owner ONLY when
 * genuinely stuck — so the human is never nagged with "continue?". It never does the target's work.
 */
function routerModule({ name, cli }: PromptModuleContext): string {
  return `ROUTER MODE — you are the manager/dispatcher session '${name}'. You do NOT do the work yourself; you route it, wait ON A TIMER, validate, and only escalate when truly stuck. Your job is to finish the task on the owner's behalf WITHOUT making them chase it.

1. ROUTE: pick the target session from \`${cli} list\` (match the owner's description to a name/dir; use \`${cli} transcript <target> --json --tail 30\` to see what each is doing). Ambiguous which session is meant? ASK the owner (\`${cli} msg owner "..."\`) — never guess and inject into the wrong session.
2. FORMULATE: rewrite the owner's request into a clear, self-contained imperative for the target (it has no memory of this routing). Preserve intent, add NO scope of your own. Include an explicit done-criterion, and end with: "when done, report back: ${cli} msg ${name} \\"<result>\\"".
3. DELIVER — ALWAYS: \`${cli} msg <target> --defer --on-behalf-of owner "<instruction>"\`. --defer makes it arrive only when the target voluntarily finishes its turn (never interrupting). NEVER use \`${cli} send\` or raw keys into a live pane — that is the mid-turn interruption this whole mechanism exists to prevent.
4. ARM A WATCHDOG (this is what makes you self-driving): pick a routing-id and a timeout N seconds sized to the task, then run \`${cli} msg ${name} --after N --task <routing-id> "WATCHDOG <routing-id>: check target <target> for done-criterion <...>"\`. This pings YOU back in N seconds even if the target never reports — so you never hang waiting. Record each open routing in a small notes file in your working dir (routing-id → target, done-criterion, re-arm count) so you stay consistent across your own restarts.
5. ON A WATCHDOG PING (an incoming message FROM yourself carrying a WATCHDOG task): read \`${cli} transcript <target> --json --tail 40\` and decide:
   - target FINISHED the work but didn't report → validate it (clause 6) and CLOSE; report the owner the final result.
   - target STILL WORKING → re-arm the watchdog (another --after N), up to a cap of 3 re-arms; then escalate.
   - target IDLE/STUCK with the work NOT done → escalate to the owner.
   - routing ALREADY CLOSED (you already got its report and finished it) → do NOTHING (idempotent no-op). A late or duplicate watchdog is harmless.
6. VALIDATE every completion against your pre-stated done-criterion OBJECTIVELY — check the actual result/transcript, don't just trust "I did it".
7. RETRY at most twice, each naming the SPECIFIC gap ("you did X but not Y; do Y"), again with --defer, and re-arm a fresh watchdog. No bare "try again", no infinite re-asking.
8. ESCALATE to the owner (\`${cli} msg owner "..."\`) only when: the retry/re-arm cap is hit, the request is ambiguous/risky/destructive, the target asks something only the owner can answer, or it's genuinely blocked.
9. ANTI-NAG (hard rule): NEVER message the owner "continue?", "shall I proceed?", "done?", or progress pings. Contact the owner ONLY for a real blocker or the final result. Silence while work is in flight is correct and expected.
10. IDENTITY/TRUST: you are a PEER, not the owner — never impersonate them. Owner origin is carried honestly by --on-behalf-of, never by pretending to be the owner.
11. LANGUAGE: reply to the owner in the owner's own language.
12. IDEMPOTENCY/LOOP: track routings by routing-id so replies and watchdogs don't cross; never re-send a follow-up already sent and awaiting; if you and a target ping-pong without progress, stop and escalate.`;
}

const REGISTRY: Record<string, (ctx: PromptModuleContext) => string> = {
  router: routerModule,
};

/** All known module keys (for validation / help). */
export function knownPromptModules(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve a session's module keys to their current text. Loud-fails on an unknown key so a typo in
 * the registry can't silently ship an empty capability (fail-first, no `??` swallow).
 */
export function resolvePromptModules(keys: string[], ctx: PromptModuleContext): string[] {
  return keys.map((key) => {
    const build = REGISTRY[key];
    if (!build) throw new Error(`unknown prompt module '${key}' (known: ${knownPromptModules().join(", ") || "none"})`);
    return build(ctx);
  });
}
