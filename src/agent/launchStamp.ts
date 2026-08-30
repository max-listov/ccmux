import { createHash } from "node:crypto";
import { z } from "zod";
import { VERSION } from "../util/version.ts";
import { providerFor } from "./index.ts";
import type { MachineConfig, Session } from "../types.ts";
import { chatEnabledFor } from "../config/chat.ts";
import { envInput, type LaunchInput } from "./launchInputs.ts";
import { LaunchRecipeMetadataSchema, ModelSelectionSchema } from "../config/schema.ts";
import { ApplicationPolicyMetadataSchema } from "../policy/reference.ts";

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
  /** The ccmux-controlled env var NAMES this launch injected — never their values. `null` means the
   *  stamp predates this field: unknown, never reported as stale (same doctrine as a missing stamp). */
  envKeys: z.array(z.string()).nullable().default(null),
  /**
   * Digests of what the launch read OUTSIDE argv, keyed by the reason each one would print: the
   * agent's global rule set, its MCP configuration, the env files the supervisor's runtime mixes in.
   * A `null` value inside the map is a stable "this input does not exist here"; the whole field being
   * `null` means the stamp predates it — unknown, and never reported as stale, the same doctrine that
   * governs a missing stamp.
   */
  inputs: z.record(z.string(), z.string().nullable()).nullable().default(null),
  /** Safe immutable host recipe identity. Older stamps omit it and therefore remain unknown rather
   * than stale; recipe definitions and environment values never enter the stamp. */
  launchRecipe: LaunchRecipeMetadataSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  applicationPolicy: ApplicationPolicyMetadataSchema.optional(),
  ts: z.number(),
});
export type LaunchStamp = z.infer<typeof LaunchStampSchema>;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Everything a launch reads that argv does not carry: the provider's own external files, plus the
 * environment the SUPERVISOR contributes. The env half is core-owned rather than provider-owned
 * because it comes from the supervisor's runtime loading the session directory's `.env`, which
 * happens identically whatever agent is being launched.
 */
export function launchInputsFor(s: Session, m: MachineConfig): LaunchInput[] {
  return [...providerFor(s).launchInputs(s, m), envInput(s)];
}

const digestMap = (inputs: readonly LaunchInput[]): Record<string, string | null> =>
  Object.fromEntries(inputs.map((i) => [i.reason, i.digest]));

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
    // Deliberately NOT in the hash: argv is the recipe, and a secret must never be an argument. The
    // launch nevertheless hands the session capabilities through the environment, and those are the
    // one part of the recipe the hash cannot see — so they are recorded beside it, by NAME only.
    envKeys: [...providerFor(s).launchEnvKeys(m)].sort(),
    // The three layers argv cannot see. Hashed, never stored in full: a rule set is somebody's
    // private text and an MCP table holds credentials, so the stamp keeps a fingerprint and nothing
    // that could be read back out of it.
    inputs: digestMap(launchInputsFor(s, m)),
    permissionMode: s.permissionMode ?? m.permissionMode,
    chatEnabled: chatEnabledFor(s, m),
    promptModules: [...s.promptModules].sort(),
    ...(s.launchRecipe === undefined ? {} : { launchRecipe: s.launchRecipe }),
    ...(s.modelSelection === undefined ? {} : { modelSelection: s.modelSelection }),
    ...(s.applicationPolicy === undefined ? {} : { applicationPolicy: s.applicationPolicy }),
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
  // What the launch injects through the ENVIRONMENT — the identity pin, the chat capability. Not in
  // argv on purpose (a secret is not an argument), so the hash below cannot see it. A session started
  // before a capability existed keeps working and silently cannot use it; naming it here is what turns
  // that into something readable instead of something discovered by hitting a refusal.
  // `null` is unknown, never stale: a stamp written before this field existed says nothing about it.
  const envKeys = (xs: readonly string[] | null): string | null => (xs === null ? null : JSON.stringify([...xs].sort()));
  const before = envKeys(stamp.envKeys);
  if (before !== null && before !== envKeys(now.envKeys)) out.push("env");
  // The layers outside argv: the global rule set, the MCP configuration, the env files mixed in by
  // the supervisor's runtime. Each carries its own word, because "restart to pick up the new rules"
  // and "restart to pick up the new MCP server" are different sentences to a person deciding whether
  // to bounce a session that is in the middle of something.
  //
  // A whole `inputs` map that is null is a stamp written before this existed: unknown, never stale.
  // A single entry that is null is different and load-bearing — it says the input is genuinely
  // absent here, and "absent then, present now" is exactly the change worth reporting.
  if (stamp.inputs !== null) {
    for (const reason of [...new Set([...Object.keys(stamp.inputs), ...Object.keys(now.inputs ?? {})])].sort()) {
      if (stamp.inputs[reason] !== (now.inputs ?? {})[reason] && !out.includes(reason)) out.push(reason);
    }
  }
  if (stamp.chatEnabled !== now.chatEnabled) out.push("chat");
  if (stamp.permissionMode !== now.permissionMode) out.push("mode");
  // Sorted on BOTH sides, not just when written: a stamp on disk may predate the sorting, and
  // "the same modules in a different order" is not a change anyone should be asked to act on.
  const mods = (xs: readonly string[]): string => JSON.stringify([...xs].sort());
  if (mods(stamp.promptModules) !== mods(now.promptModules)) out.push("modules");
  if (stamp.launchRecipe !== undefined && stableRecipe(stamp.launchRecipe) !== stableRecipe(now.launchRecipe))
    out.push("recipe");
  if (JSON.stringify(stamp.applicationPolicy ?? null) !== JSON.stringify(now.applicationPolicy ?? null))
    out.push("policy");
  // Anything else the launch recipe covers — a reworded prompt, ownerLang, extraFlags. Reported only
  // when nothing more specific explains it, so the message stays as precise as the evidence allows.
  if (out.length === 0 && stamp.hash !== now.hash) out.push("config");
  return out;
}

const stableRecipe = (recipe: LaunchStamp["launchRecipe"]): string => JSON.stringify(recipe ?? null);
