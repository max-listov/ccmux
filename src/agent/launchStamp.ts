import { createHash } from "node:crypto";
import { z } from "zod";
import { VERSION } from "../util/version.ts";
import { providerFor } from "./index.ts";
import type { MachineConfig, Session } from "../types.ts";

/**
 * What a session was LAUNCHED with — so "does this one still need a restart?" is a fact you can
 * read, not something the operator has to remember.
 *
 * Everything that shapes an agent's behaviour is injected at launch: the system prompt (chat block,
 * prompt modules, its own fleet address), `--settings` (the chat Stop hook, statusline, RC), the
 * permission mode, and the supervisor code itself. So a change to any of them lands only on the next
 * restart. ccmux already SAYS this at the moment you act ("applies on: ccmux restart …"), but a line
 * that scrolls away is not a state you can check an hour later.
 *
 * The question is deliberately NOT "is the version older". That measure lies in both directions: a
 * release that didn't touch the prompt would flag every session for nothing, while `ccmux chat on`
 * doesn't move the version at all yet absolutely requires a restart. The honest question is
 * **"would relaunching now give it something different?"** — which is directly computable.
 */
export const LaunchStampSchema = z.object({
  version: z.string(),
  hash: z.string(), // normalized launch argv
  permissionMode: z.string(),
  chatEnabled: z.boolean(),
  promptModules: z.array(z.string()).default([]),
  ts: z.number(),
});
export type LaunchStamp = z.infer<typeof LaunchStampSchema>;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Compute the stamp a launch RIGHT NOW would produce. Pure with respect to the machine/session
 * records, so `_run` (writing it) and `list` (checking it) can never disagree about the recipe.
 *
 * Two normalizations, both load-bearing:
 *  - `historyPresent` is pinned, because the flag pair only differs on a session's very first start;
 *  - the conversation uuid is replaced by a placeholder wherever it appears, because Claude re-pins
 *    it whenever a conversation forks. Without this the first fork would mark a session "stale"
 *    although nothing about its configuration changed.
 * Everything else in argv — binary, prompt text, settings blob, mode, flags — IS the policy we want
 * to compare, which is why the hash is taken over the very argv the session is spawned with rather
 * than over a hand-picked list that could drift from it.
 */
export function computeStamp(s: Session, m: MachineConfig, cli: string): Omit<LaunchStamp, "ts"> {
  const argv = providerFor(s).buildArgv(s, m, cli, true);
  const normalized = argv.map((a) => a.split(s.uuid).join("<uuid>"));
  return {
    version: VERSION,
    hash: sha(JSON.stringify(normalized)),
    permissionMode: s.permissionMode ?? m.permissionMode,
    chatEnabled: s.chatEnabled,
    promptModules: [...s.promptModules].sort(),
  };
}

/**
 * What changed since this session started, in words a human can act on. Empty = up to date.
 * A MISSING stamp yields empty too: "we don't know" must never be displayed as "stale", or the
 * first upgrade of ccmux itself would paint the whole fleet red for no reason.
 */
export function staleReasons(stamp: LaunchStamp | null, now: Omit<LaunchStamp, "ts">): string[] {
  if (stamp === null) return [];
  const out: string[] = [];
  // NOTE what is NOT compared: `version`. It was, and it did exactly what the paragraph above warns
  // against — a release touching only the daemon flagged 22 of 23 sessions, and re-launching any of
  // them would have produced a byte-identical recipe (measured: same hash, different version).
  // Nothing a restart could change escapes the checks below: the prompt, the hooks and statusline
  // (`--settings` is inline JSON in argv, not a path), the mode and every flag all live in the
  // hashed argv, while hooks themselves resolve the binary when they RUN, so a running session picks
  // up new supervisor code without restarting. A column that cries wolf across the whole fleet is
  // worse than no column: the real `chat`/`mode`/`config` drowns in it. `version` stays in the stamp
  // as diagnostics — "what was this launched on" — just not as a reason to act.
  if (stamp.chatEnabled !== now.chatEnabled) out.push("chat");
  if (stamp.permissionMode !== now.permissionMode) out.push("mode");
  // Sorted on BOTH sides, not just when written: a stamp on disk may predate the sorting, and
  // "the same modules in a different order" is not a change anyone should be asked to act on.
  const mods = (xs: readonly string[]): string => JSON.stringify([...xs].sort());
  if (mods(stamp.promptModules) !== mods(now.promptModules)) out.push("modules");
  // Anything else the launch recipe covers — a reworded prompt, ownerLang, extraFlags. Reported only
  // when nothing more specific explains it, so the message stays as precise as the evidence allows.
  if (out.length === 0 && stamp.hash !== now.hash) out.push("config");
  return out;
}
