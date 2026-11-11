import { z } from 'zod';
import { TranscriptMessageSchema } from '../agent/transcript/messageSchema.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { InventorySnapshotSchema } from '../events/schema.ts';
import {
  ContextInfoSchema,
  ListItemSchema,
  ReleaseStandingSchema,
} from '../inventory/listSchema.ts';
import { PlanLimitsSchema, PlanWindowSchema } from '../runtime/planLimits.ts';

/** The fleet's answer — its machines, their sessions and the accounts they spend on — as schemas
 *  alone, so a client reads the shape without the code that collects it. */

/**
 * A peer's session row: the same row `list --json` produces, read leniently.
 *
 * Derived rather than restated. The subset that used to live here had to gain every field the local
 * answer gained, and until it did the field was silently absent for every remote session — which
 * reads as "nothing to show" when the truth is "this schema stopped listening". A field added to the
 * local row with its own "not reported" default now arrives here by construction.
 *
 * What is overridden is only what a peer may legitimately not have, or may have differently:
 * another box can run an older or a newer build, and one un-upgraded peer must not fail the parse of
 * every row in the fleet. Unknown keys are kept rather than stripped, so a newer peer's field
 * reaches a consumer that already understands it.
 */
export const RemoteSessionSchema = ListItemSchema.extend({
  // Required locally, because a local answer must state the provider rather than let anyone infer
  // it from model, cwd or name. From a peer, absence is `unknown` — never Claude, which would turn
  // version skew into misrouting.
  agent: AgentKindSchema.nullable().default(null),
  // A state this build does not know is still a state the peer is in: read as text, not as an enum
  // that would reject the whole row.
  state: z.string().default('?'),
  running: z.boolean().default(false),
  archived: z.boolean().default(false),
  dir: z.string().nullable().default(null),
  // Identity fields the fleet view does not address by: absent from an older peer rather than empty.
  uuid: z.string().nullable().default(null),
  rc: z.string().nullable().default(null),
  lifecycleError: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  // Loosely on purpose: the transcript shape grows fields faster than a fleet of mixed builds
  // adopts them, and a row is worth more than the newest field is worth rejecting it over.
  // Every field optional and unknown keys kept: the transcript shape grows faster than a fleet of
  // mixed builds adopts it, and a row is worth more than the newest field is worth rejecting it over.
  lastMessage: TranscriptMessageSchema.partial()
    .extend({
      // Read as text, not as this build's enums: a newer peer may name a kind, a role or a status
      // this one has never heard of, and rejecting the row would cost the whole message rather than
      // the one word nobody here understands.
      kind: z.string().optional(),
      role: z.string().optional(),
      status: z.string().nullish(),
    })
    .loose()
    .nullable()
    .default(null),
  uptime: z
    .object({
      text: z.string().nullable().default(null),
      seconds: z.number().nullable().default(null),
    })
    .default(() => ({ text: null, seconds: null })),
  // The "nothing measured" shape, which is also what an older peer's silence means.
  context: ContextInfoSchema.default(() => ({
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
    rawLimitTokens: null,
    window: null,
  })),
}).loose();

/**
 * The limits as a RESPONSE carries them: the stored sample plus what is only true at read time.
 *
 * `expired` and `stale` are computed when the answer is serialized and never stored, because a
 * stored one is wrong the moment the clock moves past it. They exist so a consumer does not have to
 * derive them: every consumer doing that arithmetic separately is how one of them ends up drawing a
 * ninety-minute-old 100 % as the present, which is exactly what happened.
 */
export const ProjectedPlanLimitsSchema = PlanLimitsSchema.extend({
  /** The sample is older than a sample is allowed to be. */
  stale: z.boolean(),
  windows: z.array(PlanWindowSchema.extend({ expired: z.boolean() })).max(32),
});
export type ProjectedPlanLimits = z.infer<typeof ProjectedPlanLimitsSchema>;

/** Where one account is signed in, and how the last attempt to ask the vendor about it went. */
export const AccountProfileSchema = z.object({
  machine: z.string(),
  /** `default`, or the profile's directory. */
  profile: z.string(),
  /** How many of that machine's sessions run under it. */
  sessions: z.int().nonnegative(),
  /** Why the newest probe failed; null when it did not. */
  error: z.string().nullable(),
  attemptedAt: z.string().nullable(),
});
export type AccountProfile = z.infer<typeof AccountProfileSchema>;

/**
 * Who is spending on what, across every machine, with how much of each plan is left.
 *
 * A limit belongs to an ACCOUNT, not to a session or a machine: ten sessions on one plan share one
 * window, and drawing ten identical bars beside them would be a wrong model rather than a
 * duplicated one. So the grouping IS the answer, and it is computed once here — the printed lines
 * and the JSON slice both read it, because two implementations of "which sessions share a plan"
 * would eventually disagree about the same fleet.
 */
export const FleetAccountSchema = z.object({
  /** `<provider>:<label>`: the identity the grouping used, stable across reads. */
  id: z.string(),
  label: z.string(),
  /** How the account is served (`firstParty`, `chatgpt`), when a session or a probe named it. */
  provider: z.string().nullable(),
  /** The vendor's own word for the plan (`max`, `pro`), from the freshest measurement. Null when no
   *  source names one — it is never filled in from a guess or from a price list. */
  plan: z.string().nullable(),
  /** The display name of the plan when a source gives one (`Claude Max`); a different fact from
   *  `plan`, so neither is derived from the other. */
  subscription: z.string().nullable(),
  /** Total across the sessions that reported one. Null = nobody measured, which is not zero. */
  costUsd: z.number().nullable(),
  /** Full addresses, so a reader copies one into `ccmux msg` without reconstructing it. */
  sessions: z.array(z.string()),
  /** Every profile the account is signed in under, with the state of its newest probe. */
  profiles: z.array(AccountProfileSchema),
  /**
   * The freshest measurement any source carries for the account.
   *
   * Freshest rather than merged: two sources on one account describe the SAME windows, so a merge
   * would combine two readings of one fact and could show a window that has since reset beside one
   * that has not. Null means nothing has measured this account yet.
   */
  limits: ProjectedPlanLimitsSchema.nullable(),
});
export type FleetAccount = z.infer<typeof FleetAccountSchema>;

export const FleetMachineSchema = z.object({
  machine: z.string(),
  /** How this machine was reached; null = this machine. */
  alias: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  version: z.string(),
  /** Facts that machine reports about ITSELF: what is installed, what it last managed to read from
   *  the release feed, when it last tried and whether that worked. Null from an older peer. */
  release: ReleaseStandingSchema.nullable(),
  /**
   * How far behind it is — measured against the best release ANY machine here knows, never against
   * its own memory.
   *
   * A machine that lost its route to the release feed remembers an old "latest", and judging it by
   * that memory reports it as less behind than it is, sometimes as up to date. The error would point
   * in the reassuring direction, in exactly the case someone is looking because something seems
   * wrong. Null means level, ahead, or nothing to measure against.
   */
  behind: z.enum(['patch', 'minor', 'major']).nullable(),
  sessions: z.array(RemoteSessionSchema),
  /** That machine's published inventory — what its `inventory` events continue from. Null when it
   *  failed, publishes none, or runs a build that does not. */
  inventory: InventorySnapshotSchema.nullable(),
  /** Why this machine was asked over ssh although its route is the remote transport; null when it
   *  was asked on its configured route. */
  fallback: z.string().nullable(),
});
export type FleetMachine = z.infer<typeof FleetMachineSchema>;

/** The fleet's answer, with ONE yardstick for the whole of it. */
export const FleetViewSchema = z.object({
  /** The newest release any machine here has managed to read. Null when none of them knows. */
  latest: z.string().nullable(),
  /** When that release was published, from whichever machine read it. Null if unknown. */
  latestAt: z.string().nullable(),
  machines: z.array(FleetMachineSchema),
});
export type FleetView = z.infer<typeof FleetViewSchema>;

/** What `ccmux fleet --json` prints and `fleet.list` answers. */
export const FleetAnswerSchema = FleetViewSchema.extend({
  version: z.string(),
  generatedAt: z.iso.datetime(),
  /** Aggregated here rather than left to each consumer: the grouping is the answer, and every
   *  reader recomputing it from sessions would eventually disagree about the same fleet. */
  accounts: z.array(FleetAccountSchema),
});
export type FleetAnswer = z.infer<typeof FleetAnswerSchema>;
