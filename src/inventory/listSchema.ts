import { z } from 'zod';
import { TranscriptMessageSchema } from '../agent/transcript/messageSchema.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { InventorySnapshotSchema } from '../events/schema.ts';
import { PlanLimitsSchema } from '../runtime/planLimits.ts';
import { NativeAccountSchema } from '../runtime/projectionSchema.ts';

/*
 * The `list --json` / fleet row contract. Every persisted or remote shape has one schema; its type
 * is `z.infer` of it.
 */

/** Live state of a session. working/idle resolve pane, lifecycle and bounded turn evidence;
 *  stopped = not running;
 *  external = a live Claude session running OUTSIDE ccmux (discovered, read-only). */
export const SessionStateSchema = z.enum(['working', 'idle', 'stopped', 'blocked', 'external']);

/** Context-window fill. Tokens are null when claude surfaces no statusline AND no
 *  transcript usage exists yet — we never invent a window. */
export const ContextInfoSchema = z.object({
  text: z.string().nullable(),
  usedTokens: z.number().nullable(),
  limitTokens: z.number().nullable(),
  percent: z.number().nullable(),
  /**
   * The model's own ceiling, beside the window the turn is actually judged against.
   *
   * Both are needed because the same percentage means two different things: against the model's
   * limit there is room left, against a smaller compaction window the turn is about to be folded.
   * A reader given only the percentage cannot tell which — and starts inferring the ceiling from
   * the model's NAME, which is deriving a fact from a string when the declared one exists.
   */
  rawLimitTokens: z.number().nullable().default(null),
  /**
   * Which of the two the percentage was measured against.
   *
   * Null is "this source does not say" — a session whose fill is scraped from a status line has no
   * way to know, and a peer running an older build does not report it. Neither is the same as
   * `model-limit`, and answering with it would be inventing the half that is missing.
   */
  window: z.enum(['model-limit', 'compaction-window']).nullable().default(null),
});

export const ListItemSchema = z.object({
  name: z.string(),
  // Provider is part of the session identity surface, not something consumers may infer from
  // model/cwd/name. This field is required for local `list --json`; fleet's version-tolerant
  // remote adapter represents an older peer that omitted it as `unknown`, never as Claude.
  agent: AgentKindSchema,
  dir: z.string(),
  uuid: z.string(),
  rc: z.string(),
  running: z.boolean(),
  archived: z.boolean(),
  state: SessionStateSchema,
  // The blocking menu this session is sitting at, if any. Separate from `state` on purpose: every
  // other signal reads such a session as idle — still pane, no tool running — when it is the exact
  // opposite, unable to proceed until someone answers. Null also means "we cannot see menus on this
  // provider", which is why it is reported rather than folded into the state enum.
  atPrompt: z.string().nullable().default(null),
  // Who this session is waiting for, while it waits. The mirror image of `atPrompt` and here for
  // the same reason: every other signal reads a waiting session as working — it IS mid-turn, since
  // the wait runs inside one — when what it is actually doing is holding for another session. This
  // is the one edge a "who is holding whom" chain can be built from. Null is "not waiting", or a
  // wait whose process is gone; it is never a claim about how long a turn has run.
  waitingFor: z.string().nullable().default(null),
  lifecycleError: z.string().nullable(),
  model: z.string().nullable(),
  // The model id as the runtime reported it, beside its display label. The label cannot answer who
  // MADE the model — the display transform drops the vendor prefix — and a peer that predates this
  // field simply has no mark, which is the honest answer rather than a guessed one.
  modelId: z.string().nullable().default(null),
  context: ContextInfoSchema,
  uptime: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
  // What a restart would change for this session; empty = nothing (or launched before stamping).
  // Deliberately unaffected by `role`: a role is addressing metadata, not launch input, so declaring
  // one must never paint a session as needing a restart.
  stale: z.array(z.string()).default([]),
  // Why `stale` could not be computed by the reader that built this row — its launch recipe does not
  // build there — or null when it could. Unmeasured is its own answer: an empty `stale` beside it
  // does not mean "nothing to pick up".
  staleUnknown: z.string().max(200).nullable().default(null),
  /** What this session is FOR, when it declares it. Null is an ordinary state, not missing data —
   *  such a session is addressed by name, as it always was. */
  role: z.string().nullable().default(null),
  /**
   * When the turn that is running RIGHT NOW began, or null.
   *
   * An ABSOLUTE instant, not "N milliseconds so far", and the difference is not a style choice. An
   * elapsed number is only true at the instant it is produced: a snapshot that travelled a network
   * and sat in a consumer's cache carries a counter short by exactly the delivery time, and the
   * gap widens the less often that consumer refreshes. An instant reads the same however late it is
   * read, so the consumer subtracts it from its own clock and ticks locally — no polling, no
   * subscription, and nothing to keep in sync.
   *
   * Null means the session is not in a turn, or is in one whose start nobody recorded (a provider
   * without turn hooks, or a turn already running when ccmux started). Those two are told apart by
   * `state`: `working` with a null instant is "in a turn, start unknown", which a consumer should
   * show as working without a counter rather than as a turn that began just now.
   */
  turnStartedAt: z.string().nullable().default(null),
  /**
   * Which account this session runs on, for the runtimes that name one, and what it has spent.
   *
   * An identity, never a credential: no token, key, or the name of where one came from. It exists
   * so an operator can answer "which sessions share this account" without opening each of them —
   * which, on a fleet running against a subscription, is how a limit is seen before it is hit.
   */
  account: NativeAccountSchema.nullable().default(null),
  /**
   * How much of the plan the ACCOUNT this session runs on has used.
   *
   * Beside `account` on purpose: the window belongs to the account, so many sessions on one plan
   * report the same windows and a reader groups them on the label rather than drawing ten
   * independent bars. Null means this build never asked; a runtime that HAS been asked and does not
   * publish the fact says so inside, because "unpublished" and "nothing used" are opposite facts.
   */
  planLimits: PlanLimitsSchema.nullable().default(null),
  costUsd: z.number().nullable().default(null),
  /** The env file this session declares (absolute), and whether it exists right now. A declared file
   *  that is missing does not stop the session — the original decision was "raise it and shout", since
   *  a session that will not boot is worse for a supervisor than one variable short — so this is how a
   *  reader finds out at all. Null = nothing declared. */
  envFile: z.object({ path: z.string(), present: z.boolean() }).nullable().default(null),
  createdAt: z.string().nullable(),
  lastMessage: TranscriptMessageSchema.nullable(),
  /**
   * How many letters this session has exchanged, from the machine's whole exchange record.
   *
   * The count exists because a consumer cannot derive it: what a consumer can reach is a WINDOW of
   * the log, and a count taken over a window is the size of the window. Measured on one machine over
   * two minutes it read 65, then 70, then 13, then 7 — moving with each snapshot rather than with
   * the conversation. `{ total: 0, lastAt: null }` is a session that has never exchanged one; a peer
   * too old to report the field is null, which is "did not say" rather than "none".
   */
  letters: z
    .object({ total: z.number().int().nonnegative(), lastAt: z.string().nullable() })
    .nullable()
    .default(null),
  /**
   * Where this session lives in tmux, declared rather than guessed: the server (`socket` is the `-L`
   * name, null for the default server), the tmux session name, and the agent's pane by tmux's own id.
   * A consumer that addresses the session derives nothing from its ccmux name, so a rename or a move to
   * a named socket changes this data instead of silently sending its commands elsewhere. `agentPane`
   * is null for a session created before the id was recorded. Null for a session that is not running,
   * and for a peer too old to report it.
   */
  tmux: z
    .object({
      socket: z.string().nullable(),
      session: z.string(),
      agentPane: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

/**
 * How this machine stands against the newest published release.
 *
 * `latest: null` means NOT KNOWN — no release feed configured, or no check has ever completed. It is
 * a different state from "up to date" (`latest` set, `behind: null`), and collapsing the two would
 * draw a machine as healthiest exactly when nothing has verified it.
 *
 * `ok: false` with a non-null `latest` means "this is what we knew, and we can no longer reach the
 * feed to confirm it" — a reader should dim that machine rather than trust it. `checkedAt` says when
 * the last attempt was, so staleness is visible instead of assumed.
 *
 * `behind` is classified HERE rather than left to each reader: otherwise every consumer
 * reimplements a semver comparison and they disagree about the same machine.
 */
export const ReleaseStandingSchema = z.object({
  /** What is installed here. */
  current: z.string(),
  /** The newest release THIS machine has managed to read, retained across later failures.
   *  Null = not known: no release feed configured, or no check has ever completed. */
  latest: z.string().nullable().default(null),
  /** When that release was published, when the manifest said. Null on an older manifest. */
  latestAt: z.string().nullable().default(null),
  /** When a check was last ATTEMPTED here — success or failure. */
  checkedAt: z.string().nullable().default(null),
  /** Did that last attempt succeed? `false` with a non-null `latest` means "this is what we knew,
   *  and we can no longer reach the feed to confirm it". */
  ok: z.boolean().default(true),
  /** Has the ASKING stopped? True when the last attempt is far older than this machine's own check
   *  interval — nothing is looking any more, whatever the last look returned. Computed here because
   *  only this machine knows its interval; `false` from a peer too old to report it. */
  checksOverdue: z.boolean().default(false),
});

export const ListJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  rcPrefix: z.string(),
  stateDir: z.string(),
  release: ReleaseStandingSchema,
  sessions: z.array(ListItemSchema),
  /**
   * The daemon's published inventory: the snapshot its `inventory` events continue from. Null when
   * no live daemon publishes one. `sessions` above is this call's own fresh answer and is not it.
   */
  inventory: InventorySnapshotSchema.nullable(),
});
