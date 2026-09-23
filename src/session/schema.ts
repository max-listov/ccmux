import { z } from 'zod';
import { AgentKindSchema, SESSION_NAME_RE } from '../chat/identitySchema.ts';
import {
  LaunchRecipeMetadataSchema,
  ModelSelectionSchema,
  NativeSessionSchema,
  PermissionModeSchema,
} from '../config/launchSchema.ts';
import { ApplicationPolicyMetadataSchema } from '../policy/schema.ts';

/*
 * The session registry: a managed session, one still being created, and a lifecycle block. Every
 * persisted or remote shape has one schema; its type is `z.infer` of it.
 */

/**
 * One ccmux-managed agent conversation.
 *
 * The sessions FILE is JSONL — one of these per line. `uuid` is the authoritative READY
 * conversation identity and drives deterministic resume. Codex fresh launch is correlated in a
 * separate pending transaction; a placeholder is never persisted as a Session.
 */
export const SessionSchema = z.object({
  // tmux session name. 'cc-' is convention, not enforced. Forbid '|' (legacy
  // delimiter), whitespace, and '#' (comment-line safety in the sessions file).
  name: z
    .string()
    .min(1)
    .regex(
      SESSION_NAME_RE,
      "name: no '|', whitespace, '#' or ':' (':' separates a fleet address machine:session — and tmux splits a target at the first ':', so such a session could never be captured or sent to anyway)",
    ),
  // Absolute working dir. Basis for both `cwd` and the history-jsonl path. MUST be
  // absolute or Claude's project-dir encoding won't match (see claude/resume.ts).
  dir: z.string().startsWith('/', 'dir must be absolute'),
  // Pinned conversation uuid — the single source of identity for resume.
  uuid: z.uuid(),
  // The exact create transaction that promoted this ready row. Present for managed Codex
  // bootstrap so a late success/rollback can never accept or remove a same-name replacement.
  registrationGeneration: z.uuid().optional(),
  // Per-session extra provider flags, as an ARRAY (never a string). Passed straight
  // to Bun.spawn argv — no shell ever sees them, so e.g. "claude-opus-4-8[1m]" is
  // a plain element and the whole shlex/glob bug class is structurally gone.
  flags: z.array(z.string()).default([]),
  // Parked but kept: stays in the file (history preserved), skipped by ensure/daemon.
  // Lets you stop healing a session without removing it.
  archived: z.boolean().default(false),
  // Rate-limit auto-resume: the text steered to a parked session at reset.
  resumeText: z.string().default('continue'),
  // Which agent CLI backs this session. It is authoritative routing identity, so it is
  // required on every row and can never be inferred from history, cwd, or a default.
  agent: AgentKindSchema,
  // Opt-in native Codex App Server; the terminal is a client of the same provider writer.
  // Absent keeps the ordinary interactive provider launch.
  runtime: z.enum(['tui', 'app-server', 'native']).optional(),
  nativeSession: NativeSessionSchema.optional(),
  // Per-session permission-mode OVERRIDE. Undefined → inherit the machine default
  // (MachineConfig.permissionMode). Set it to gate ONE session differently from the box
  // default — e.g. the box is bypassPermissions but a client-prod session stays "auto".
  // Escalated modes cannot be set at all under a root daemon — the provider refuses them there, so a
  // session configured with one would simply never start. The launch guard remains as a last line of
  // defence for a hand-edited config.
  permissionMode: PermissionModeSchema.optional(),
  // Per-session chat OVERRIDE. Undefined → inherit the machine default (MachineConfig.chatEnabled).
  // Set it to gate ONE session differently from the box — e.g. the machine has chat on, but a
  // client-facing session stays silent. Never read directly: every consumer goes through the single
  // resolver (config/chat.ts), or the two levels drift and half the system thinks chat is on.
  chatEnabled: z.boolean().optional(),
  // Named prompt modules composed INTO the injected system prompt (buildPrompt) at every
  // launch/heal, on top of the base management prompt. Each key is resolved against the in-code
  // module registry (agent/prompt/promptModules.ts) — the module TEXT is versioned CODE; only the NAME
  // is persisted here, so an updated module reaches every session on its next restart and NEVER
  // goes stale (unlike snapshotting text). Unknown key → loud fail at launch. This is data (a
  // free-form key), not a role enum: a new capability = a new registry entry, no schema change.
  // Today's one module is "router" (the autonomous-manager protocol).
  promptModules: z.array(z.string()).default([]),
  /**
   * The env file this session DECLARES, or absent for "no file". Relative paths resolve against
   * `dir`; absolute is allowed.
   *
   * It exists because the alternative was already happening by accident. `_run` is a Bun process
   * whose cwd is the session directory, the runtime loads that directory's `.env` into itself, and
   * the launcher copied its whole environment into the agent — so a project's secrets reached the
   * agent and every process it spawned, undeclared and invisible. Measured on a live fleet: 5 of 14
   * sessions were carrying project variables that way, API keys among them.
   *
   * One file, not a list: a list would demand a precedence puzzle, and composition belongs inside
   * the file. Named here rather than resolved at launch, because "what is this session's recipe" has
   * to be answerable without launching it.
   */
  envFile: z.string().min(1).optional(),
  /** Safe immutable identity of the host recipe that produced `flags` and `envFile`. The resolved
   * definition is deliberately not stored here: the existing session fields remain launch truth. */
  launchRecipe: LaunchRecipeMetadataSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  applicationPolicy: ApplicationPolicyMetadataSchema.optional(),
  /** Per-session opt-out from the event feed. Undefined → follow the machine. Same two-level shape
   *  as `chatEnabled`, for the session nobody wants announced. */
  eventsEnabled: z.boolean().optional(),
  /**
   * Whether the runtime keeps a copy of every file this session modifies, so an edit can be undone.
   *
   * Off unless asked for, and asked for per session rather than per host: a supervisor that quietly
   * starts copying a working tree is a surprise, not a feature. Turning it on widens what this
   * project is answerable for — the tree, not only the conversation — which is why it is a decision
   * somebody makes rather than a default somebody discovers.
   */
  fileCheckpoints: z.boolean().optional(),
  /**
   * What this session is FOR — the part of an identity a name does not carry.
   *
   * A name is chosen once, and it is usually the project's. A project has several sessions, and only
   * one of them owns any given decision — so an address picked from a project name resolves, is
   * delivered, exits zero, and lands on the neighbour. That failure reports nothing at all: the
   * sender spends an hour believing it answered the owner.
   *
   * Deliberately free text under the address-token rules rather than an enum: the useful roles are a
   * project's own vocabulary, and an enum would force every new kind of work through a schema
   * change. Absent is the ordinary state — a session without one is addressed by name, as before.
   *
   * It must stay CHEAP to change (`ccmux role`, no restart). A second name that is expensive to
   * update is worse than no second name: within a week it lies, and by then people trust it.
   */
  role: z
    .string()
    .min(1)
    .regex(SESSION_NAME_RE, "role: no '|', whitespace, '#' or ':' — a role is an address token")
    .optional(),
});

/** A fresh managed launch that has not yet produced an authoritative provider thread id. */
export const PendingSessionSchema = z
  .object({
    generation: z.uuid(),
    marker: z.string().regex(/^ccmux_[0-9a-f-]{36}$/),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('create') }),
      z.object({ kind: z.literal('adopt'), sourceThreadId: z.uuid() }),
      z.object({ kind: z.literal('fork'), sourceThreadId: z.uuid() }),
    ]),
    session: SessionSchema.omit({ uuid: true }),
    createdAt: z.iso.datetime(),
    status: z.enum(['pending', 'blocked', 'promoted']),
    error: z.string().min(1).optional(),
    uuid: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'promoted' && value.uuid === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['uuid'],
        message: 'promoted pending session requires uuid',
      });
    }
  });

/** Durable terminal lifecycle failure. The daemon will not heal a blocked ready session. */
export const LifecycleBlockSchema = z.object({
  name: SessionSchema.shape.name,
  agent: AgentKindSchema,
  uuid: z.uuid().optional(),
  generation: z.uuid().optional(),
  error: z.string().min(1),
  at: z.iso.datetime(),
});
