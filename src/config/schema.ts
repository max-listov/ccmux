import { z } from 'zod';
import {
  AgentKindSchema,
  ChatPrincipalSchema,
  ChatTargetSchema,
  RC_PREFIX_RE,
  SESSION_NAME_RE,
} from '../chat/identitySchema.ts';

export {
  AgentKindSchema,
  ChatPrincipalSchema,
  ChatTargetSchema,
  CliPrincipalSchema,
  CodexAppPeerSchema,
  ExternalTargetSchema,
  ManagedPeerSchema,
  OwnerTargetSchema,
  RC_PREFIX_RE,
  SESSION_NAME_RE,
  ServicePrincipalSchema,
} from '../chat/identitySchema.ts';

import { CustomLaunchConfigSchema } from '../agent/custom/config.ts';
import { AttachmentReferencesSchema } from '../attachments/reference.ts';
import {
  MessageApplicationsSchema,
  MessageOriginSchema,
  NotificationAudienceSchema,
} from '../chat/originSchema.ts';
import { ExternalTurnStateSchema } from '../external/turnSchema.ts';
import { AgentPoliciesSchema, ApplicationPolicyMetadataSchema } from '../policy/schema.ts';
import { NativeAccountSchema } from '../runtime/projectionSchema.ts';
import {
  AcceptedTurnOptionsSchema,
  NativeModelSelectionSchema,
} from '../runtime/selectionSchema.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for every persisted/remote shape. No bare interfaces,
// no `as` — every type below is `z.infer` of one of these schemas (see types.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Any Claude Code permission mode (matches `claude --permission-mode` choices).
 *  Shared by the machine default and the per-session override so the two can't drift. */
export const PermissionModeSchema = z.enum([
  'auto',
  'manual',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
]);

/** Provider continuation is not the managed registration UUID. */
export const NativeSessionSchema = z
  .object({
    runtime: z.enum(['opencode', 'custom', 'claude']),
    id: z.string().min(1).max(256),
    version: z.string().min(1).max(64),
  })
  .strict();

/** Public-safe identity of an execution-host launch recipe. The reference contains no path,
 * command, environment value or provider credential. */
export const LaunchRecipeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/);
export const LaunchRecipeRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const LaunchRecipeCapabilitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/);
/** Native provider collaboration modes that a host recipe may pin. The public caller never sends
 * the mode or its settings; it selects only the immutable recipe reference. */
export const CodexCollaborationModeSchema = z.enum(['default', 'plan']);
export const LaunchRecipeReferenceSchema = z
  .object({
    id: LaunchRecipeIdSchema,
    revision: LaunchRecipeRevisionSchema,
  })
  .strict();
export const ModelSelectionSchema = NativeModelSelectionSchema;
export const LaunchRecipeMetadataSchema = LaunchRecipeReferenceSchema.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.array(LaunchRecipeCapabilitySchema).max(32),
  collaborationMode: CodexCollaborationModeSchema.optional(),
}).strict();

/** Private host configuration. Values stay on the execution host; only LaunchRecipeMetadata is
 * projected through control APIs. `environment` names capabilities the recipe requires without
 * carrying their values, and `flags` goes through the existing owned App Server allowlist. */
export const MachineLaunchRecipeSchema = z
  .object({
    revision: LaunchRecipeRevisionSchema,
    envFile: z.string().min(1).optional(),
    flags: z.array(z.string().min(1).max(4_096)).max(32).default([]),
    environment: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(32)
      .default([]),
    capabilities: z.array(LaunchRecipeCapabilitySchema).max(32).default([]),
    /** Select the provider's installed preset on every turn. Model, effort and built-in instructions
     * are resolved from the provider; the recipe stores no caller-authored prompt. */
    collaborationMode: CodexCollaborationModeSchema.optional(),
    custom: CustomLaunchConfigSchema.optional(),
  })
  .strict();

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
  // module registry (agent/promptModules.ts) — the module TEXT is versioned CODE; only the NAME
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

/** Optional Telegram sink for explicit owner notices — a group, a
 *  DM, or a specific forum topic. Any ccmux user drops in their own @BotFather token + target;
 *  absent → no mirroring (fail-soft). Set in machine.json. */
export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1), // @BotFather token (secret)
  chatId: z.string().min(1), // numeric group/DM id (a string — supergroups are negative)
  topicId: z.number().int().positive().optional(), // message_thread_id of a forum topic
});

/**
 * Per-machine config: the ONE-artifact / many-configs split. Everything that
 * differs between local/dev/prod lives here, never in code.
 */
export const MachineConfigSchema = z.object({
  // Absolute binaries — differ per machine (ordered-fallback-detected, overridable).
  claudeBin: z.string().startsWith('/'),
  // Codex CLI binary — optional; only required for agent="codex" sessions.
  codexBin: z.string().startsWith('/').optional(),
  opencodeBin: z.string().startsWith('/').optional(),
  /**
   * Opt-in for the native Claude execution mode, off unless this host turns it on.
   *
   * The mode drives the operator's own `claude` binary through the published agent SDK instead of a
   * terminal. Which authentication a given deployment may use with that path is the operator's
   * decision to read and apply, and this flag is where that decision is expressed — which is why
   * there is no default that enables it. Interactive Claude sessions are unaffected either way.
   */
  claudeNativeRuntime: z.boolean().default(false),
  /**
   * Package root of the agent SDK this host runs the native mode with.
   *
   * A path rather than a bundled copy, exactly like `codexBin` and `opencodeBin`: the SDK is a
   * vendor runtime, and only our own harness is embedded. It also keeps the SDK/CLI pairing — which
   * the vendor releases in lockstep — under the operator's control rather than pinned to whenever
   * this project last cut a release.
   */
  claudeNativeSdk: z.string().startsWith('/').optional(),
  tmuxBin: z.string().startsWith('/'),
  // Optional dedicated tmux SOCKET (`tmux -L <socket>`). Unset → the default socket (prod). Set →
  // every tmux call is scoped to this socket, so an ISOLATED instance gets its OWN tmux server:
  // own panes, no name collisions, and — key — that server inherits the launching env, so `_run`
  // panes read THIS instance's CCMUX_CONFIG. This is how a dev instance runs beside prod cleanly.
  tmuxSocket: z.string().min(1).optional(),
  // Remote Control visibility. Default true = sessions show in the claude.ai app (drive from phone).
  // A dev/isolated instance sets false so its throwaway sessions don't clutter the app or get
  // confused with prod ones (turns RC off via claude's `disableRemoteControl` setting at launch).
  remoteControl: z.boolean().default(true),
  // Claude's project-history root; basis for the resume existence check.
  // local: /Users/u/.claude/projects, servers: /root/.claude/projects.
  projectsDir: z.string().startsWith('/'),
  // Codex's rollout-session root — basis for the Codex transcript locator.
  // default: ~/.codex/sessions. Optional; only needed for agent="codex" sessions.
  codexSessionsDir: z.string().startsWith('/').optional(),
  // Codex state root. Writer locks are sibling state, not derivable from an arbitrary sessions
  // override; ownership admission therefore requires this first-class path.
  codexHome: z.string().startsWith('/').optional(),
  // Bound for a fresh Codex TUI to persist its launch marker before the create transaction fails.
  codexCorrelationTimeoutMs: z.number().int().min(100).default(30_000),
  /** Named launch policies selected by the public control API. Callers can name and pin one, but
   * cannot supply any definition field or secret value themselves. */
  launchRecipes: z.record(LaunchRecipeIdSchema, MachineLaunchRecipeSchema).default({}),
  agentPolicies: AgentPoliciesSchema,
  messageApplications: MessageApplicationsSchema,
  // RC display-name prefix so the phone/Telegram client knows which box a session is on. A
  // free-form lowercase slug (local, dev, prod, staging, …) — see RC_PREFIX_RE. The regex
  // loud-fails on garbage (the real intent), and `install` refuses if it can't be set.
  rcPrefix: z
    .string()
    .regex(RC_PREFIX_RE, 'rcPrefix must be a lowercase slug (e.g. local, dev, prod, staging)'),
  // Fleet directory: machine label (another box's rcPrefix) → ssh alias. This is what makes
  // `ccmux msg dev:api` possible; absent/empty = fleet addressing simply isn't available here and
  // everything behaves exactly as before. Keys are validated as rcPrefix slugs, so a machine label
  // can never itself contain the ':' separator. Verified end-to-end by `ccmux doctor`, which checks
  // that each alias really reports the rcPrefix it is mapped to (a mis-mapped entry would deliver
  // correctly-addressed mail to the wrong machine — the exact failure this feature exists to kill).
  // The VALUE is an ssh alias we hand to `ssh` as its own argv element: a leading '-' would be read
  // as an option (`-oProxyCommand=…`), so the shape is pinned rather than trusted.
  fleet: z
    .record(
      z.string().regex(RC_PREFIX_RE),
      z
        .string()
        .regex(
          /^[A-Za-z0-9][A-Za-z0-9._@-]*$/,
          "fleet alias must be an ssh host alias (no leading '-', no spaces)",
        ),
    )
    .optional(),
  /**
   * The stitchwire transport: machines this box reaches through the local stitchwire agent instead
   * of through ssh.
   *
   * It exists because ssh can only call a machine that is reachable, and a roaming laptop never is.
   * stitchwire has every node dial OUT to a broker and keep that link, so a server can finally
   * address the laptop — without the laptop opening a port or a server holding a key to it. The
   * connection direction changes; the trust model does not.
   *
   * Listing a machine here is the entire switch, per direction: absent = ssh exactly as before.
   * That is deliberate — a new transport earns its place one direction at a time, and a fleet-wide
   * flag would make "which path did that call take" unanswerable during the change.
   *
   * INVARIANT: a stitchwire node id IS the machine's `rcPrefix`. One label names one machine in
   * both systems; a mismatch would deliver correctly-addressed mail to the wrong box.
   */
  /**
   * Whether this machine writes the session event feed. Default ON: the feed is one append per
   * transition and nothing while nothing happens, and a supervisor that stays quiet about what its
   * sessions did is the state this replaces. The switch exists for an isolated instance or a machine
   * whose state directory must stay minimal — not as a thing anyone is expected to think about.
   */
  sessionEvents: z.boolean().default(true),
  /**
   * Component owners who work OUTSIDE this fleet, and how a person reaches them.
   *
   * The value is prose on purpose — it is read by a human, who is the transport. Anything more
   * structured would be a promise ccmux cannot keep: it does not speak to that product, and
   * pretending to know the route would invite an automatic delivery that cannot exist.
   *
   * Declaring a name is what takes that party OUT of the session namespace. Undeclared, people
   * addressed the project instead, and a project name is usually also a session name.
   */
  externals: z.record(z.string().regex(SESSION_NAME_RE), z.string().min(1)).default({}),
  wire: z
    .object({
      peers: z.array(z.string().regex(RC_PREFIX_RE)).default([]),
      // Absent = the agent's default path under this user's home. Set only by an isolated instance.
      socket: z.string().startsWith('/').optional(),
    })
    .optional(),
  // Optional command run once before a batch of outbox retries, for fleets where transit can be
  // restored locally (re-pointing a forwarded-key socket, refreshing a token). An argv ARRAY, never
  // a string: no shell ever sees it. Absent = nothing runs, which is the default everywhere.
  transitPreflight: z.array(z.string().min(1)).min(1).optional(),
  // Where this instance keeps everything durable — registry, chat, outbox, status, log. A
  // DIRECTORY, and one nobody normally sets: the loader derives it from the platform's state root,
  // so a fresh machine lands correctly with no entry here at all. It exists purely as the single
  // knob an isolated instance (or a test) flips to get its own state. The predecessor was a
  // REQUIRED path to one FILE whose directory implied where five other files went — which made
  // machines drift by construction and let one careless value relocate the whole set.
  stateDir: z.string().startsWith('/'),
  // Daemon heal period (seconds). Per-machine-tunable, re-read live each loop.
  ensureInterval: z.number().int().positive().default(30),
  // Machine-wide DEFAULT permission mode (matches `claude --permission-mode` choices).
  // A session can override it per-session (Session.permissionMode). Escalated modes
  // (bypassPermissions/dontAsk) are honored for non-root daemons. Under root they require the
  // machine to declare allowEscalatedUnderRoot (see below); without it they are refused where they
  // are SET, rather than accepted as a setting that cannot be honoured.
  permissionMode: PermissionModeSchema.default('auto'),
  /**
   * This machine accepts agents running unrestricted under its root daemon.
   *
   * Escalated modes are blocked twice over: ccmux downgrades them, and the agent itself refuses to
   * start as root. The agent's own escape hatch is an environment variable that declares the process
   * to be sandboxed — so honouring this flag means ccmux ASSERTS that to the agent on every launch.
   *
   * Read that plainly before setting it: on a bare server the assertion is not true. What the flag
   * really says is "I accept an agent acting as root here with nothing to approve it". That is a
   * legitimate choice for a box whose owner wants exactly that, and an expensive one to make by
   * accident — which is why it is per-machine, explicit, and never a default.
   *
   * Turning it on changes the launch environment, so the launch stamp reports `env` and `list` asks
   * for the restart that actually applies it.
   */
  allowEscalatedUnderRoot: z.boolean().default(false),
  // Machine-wide DEFAULT for inter-agent chat, mirroring how permissionMode works. Still OFF by
  // default, because chat traffic is never implicit — turning it on is a deliberate act, just one
  // performed ONCE per machine instead of once per session. A session may still override either way.
  chatEnabled: z.boolean().default(false),
  /**
   * Whether the fleet view scans for agent threads running OUTSIDE ccmux. Off by default: the
   * inventory is evidence gathered for a decision (adopt, fork, take over), and a machine that
   * is not making that decision should not pay for it on every launch. The scan walks every
   * stored transcript on the box, so its cost tracks accumulated history rather than fleet size.
   *
   * The view toggles it live with `x`; this is only where the machine's starting answer lives.
   */
  externalInventory: z.boolean().default(false),
  // Boot-unit label so install + update-bounce can target it.
  // launchd: "com.ccmux.daemon"; systemd: "ccmux.service".
  bootLabel: z.string().min(1),
  // Self-update source (where release.json lives — any URL incl. file://). Optional —
  // `update` is a clear no-op when unset.
  releaseUrl: z.url().optional(),
  // Daemon self-update: when true + releaseUrl set, the daemon auto-checks every
  // updateCheckInterval seconds and applies a newer release (bounce, sessions survive).
  autoUpdate: z.boolean().default(false),
  updateCheckInterval: z.number().int().positive().default(300),
  // Fleet-wide extra flags appended to every session (after per-session flags).
  extraFlags: z.array(z.string()).default([]),
  // System-log threshold (the state root's ccmux.log). Re-read live by the daemon each tick —
  // flip to "debug" on a misbehaving box without restarting anything.
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Claude 2.1.x shows a BLOCKING "Resume from summary?" picker on `--resume` of a large/old
  // session; an unattended (daemon-healed) resume would strand at that menu — typed input lands
  // on the MENU, not the conversation, so after a reboot every big session sits dead until a
  // human answers it. The supervisor auto-answers per this policy: "full" = resume full, keep
  // ALL context (default — never lose work); "summary" = resume compacted; "off" = never
  // auto-answer (a human will). Claude-only; other agents have no such picker.
  resumePicker: z.enum(['full', 'summary', 'off']).default('full'),
  /**
   * Claude asks, on first use of a directory, whether the folder is trusted — and a supervised
   * session has nobody to answer, so it sits at that menu unable to do anything. The levels escalate
   * and the split is deliberate, because two different questions hide behind one dialog:
   *
   *   "folder" (default) — answer the plain trust question. Registering a session that points at a
   *     directory IS the owner's declaration that they trust it; asking a second time, of nobody,
   *     only strands the session.
   *   "declared" — ALSO accept the variant where the folder pre-approves tool permissions written in
   *     its own `.claude/settings.local.json`. Nobody has read those, and a checked-in file would get
   *     its permissions granted silently — so this is never the default.
   *   "off" — answer neither; a human will.
   *
   * Whatever the policy, an unanswered menu is reported rather than hidden: `list`, the TUI and
   * `doctor` all show a session waiting at a prompt as waiting, never as idle.
   */
  trustPrompt: z.enum(['off', 'folder', 'declared']).default('folder'),
  // Optional Telegram mirror of the inter-agent chat (see TelegramConfigSchema). Absent → off.
  telegram: TelegramConfigSchema.optional(),
  // Optional owner language OVERRIDE for messages a session sends to `owner`. Unset (default) →
  // sessions mirror the language the owner wrote in (zero-config, adapts per message). Set (e.g.
  // "Russian") → the injected prompt tells sessions to reply to the owner in that language. No
  // hardcoded default value (public repo). Purely advisory prompt guidance, not enforced.
  ownerLang: z.string().min(1).optional(),
});

/**
 * Remote release descriptor for `update` — replaces a VERSION/NOTES text dance.
 * The version regex only VALIDATES a known shape; it never parses unknown data.
 */
export const ReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  notes: z.string().default(''),
  // verify the artifact bytes BEFORE swapping it in (supply-chain safety).
  sha256: z.string().length(64),
  url: z.url(),
  /** When this release was cut. Optional because manifests published before it exists have none —
   *  and it is worth having: "two minors behind" is a class, while "three days behind" is the thing
   *  a person actually wants to know when deciding whether to care. */
  releasedAt: z.iso.datetime().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inter-agent chat — an append-only message ledger (the source of truth) plus a
// separate cursors file. A message is immutable once written; delivery/read state
// lives in the cursors (single writer = the daemon), never mutated back into the
// ledger. This keeps the ledger a clean, replayable, exportable log for debugging.
// ─────────────────────────────────────────────────────────────────────────────

/** One immutable v2 chat envelope. `task` is an optional pointer so the channel stays a phone call
 * (details live in the task). There are deliberately no defaults: mixed/old wire shapes fail. */
/**
 * Generation of the chat record format. It lives IN the record, not in a file name: a reader can
 * then refuse a foreign record by name ("generation 1, this build reads 2") instead of complaining
 * about a field shape — and the files keep canonical names across every future generation. Encoding
 * it in the filename instead was the mistake this replaces: `chat-v2.jsonl` is a lie the moment
 * there is a 3, and it puts a dead archive right beside live state under a near-identical name.
 */
export const CHAT_GENERATION = 2;

export const ChatMessageSchema = z
  .object({
    // First field on the wire and on disk, so a foreign record is identified before anything else is
    // interpreted. `.strict()` below would already reject an older record — but on the shape of
    // `from`, which reads as a bug rather than as "this is from another generation".
    v: z.literal(CHAT_GENERATION),
    id: z.uuid(), // unique per message
    ts: z.string(), // ISO-8601 send time
    from: ChatPrincipalSchema,
    to: ChatTargetSchema,
    origin: MessageOriginSchema.optional(),
    notification: NotificationAudienceSchema.optional(),
    registrationGeneration: z.uuid().optional(),
    body: z.string(),
    task: z.string().nullable(),
    // Deferred delivery: hold until the recipient VOLUNTARILY finishes its turn — delivered by the
    // Stop hook at end-of-turn, or by the daemon once the target is STABLY idle. Never pasted while
    // the target is working (Claude's steering queue would flush it mid-turn — the whole bug this
    // fixes). False means normal peer-chat behavior.
    defer: z.boolean(),
    // Relay claim supplied by an authorized courier. It does not independently authenticate the
    // claimed author or grant execution authority; `from` remains the actual ingress principal.
    onBehalfOf: z.string().nullable(),
    // Time-delayed delivery: an ISO-8601 instant before which the daemon must NOT deliver this message
    // (skipped while now < notBefore). Powers a router's self-`watchdog` (`msg <self> --after N`) so it
    // wakes on a TIMER, not only on an inbound reply — the backbone of "the router finishes the job on
    // its own". Null → deliver as soon as eligible. A defer message can also carry notBefore (both must
    // hold). `defer || notBefore !== null` makes a message CONDITIONAL — delivered by id, off the
    // in-order cursor, so it never head-of-line-blocks immediate mail.
    notBefore: z.string().nullable(),
    turnOptions: AcceptedTurnOptionsSchema.optional(),
    images: AttachmentReferencesSchema.optional(),
    controlFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** Delivery/read bookkeeping, kept OUT of the append-only ledger. `read[managedPeerKey]` = the ledger
 *  LENGTH a recipient has read its inbox up to (unread = TO-me messages at/after that index).
 *  Grows with delivery sinks (pane/telegram) in later phases; the daemon is the single writer. */
export const ChatCursorsSchema = z.object({
  read: z.record(z.string(), z.number()).default({}),
  // per-recipient: ledger LENGTH the daemon has PUSH-delivered a session's inbox up to. Distinct
  // from `read` (advanced by `ccmux inbox` too) so a push and a manual pull don't double-count.
  // The daemon is the sole writer; survives restarts so a bounce never re-pushes old messages.
  delivered: z.record(z.string(), z.number()).default({}),
  // A pane injection is not yet a turn. Hookless providers keep the exact message here until its
  // immutable id appears as a user record in the transcript; `wait` cannot reuse an older answer.
  pickups: z
    .record(
      z.string(),
      z
        .object({
          messageId: z.uuid(),
          injectedAt: z.iso.datetime(),
          // Stored in the same atomic cursor write as the pickup intent. An immediate cursor therefore
          // cannot hide a submitted turn without leaving the exact transcript barrier behind.
          ledgerIndex: z.number().int().nonnegative().nullable().default(null),
          conditional: z.boolean().default(false),
          native: z
            .object({
              phase: z.enum(['intent', 'accepted']),
              turnId: z.string().min(1).max(256).nullable(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .default({}),
  // Telegram progress: ledger LENGTH consumed (sent, permanently refused or deliberately suppressed).
  // Persisted so a restart considers only the remaining backlog, never the whole history.
  // `null` = the mirror has never run on this machine. Distinct from 0 on purpose: turning the
  // mirror ON must start a LIVE FEED, not replay the machine's whole history into the chat. (Learned
  // the hard way: enabling it on two servers instantly re-sent 25 old messages, because every
  // message ever written was, technically, "not yet mirrored".) Existing files hold a number and are
  // unaffected.
  telegram: z.number().nullable().default(null),
});

// ─────────────────────────────────────────────────────────────────────────────
// `transcript --json` — normalized view of Claude's raw JSONL conversation log.
// Each content item becomes one message (text / tool_call / tool_result / thinking).
// Reused as `lastMessage` in `list --json` ("where the session stopped").
// ─────────────────────────────────────────────────────────────────────────────

export const TranscriptRoleSchema = z.enum(['user', 'assistant', 'tool', 'system', 'unknown']);
export const TranscriptKindSchema = z.enum([
  'message',
  'tool_call',
  'tool_result',
  'thinking',
  // An image the conversation carried. Its own kind rather than a message whose text says so:
  // `[image]` was a word where a picture had been, and nothing could turn that word back into one.
  'image',
  'event',
  'unknown',
]);

/**
 * An image in a transcript, addressed rather than inlined.
 *
 * The bytes stay out of the record on purpose: a message list is read constantly (it backs
 * `lastMessage` in `list --json`), and carrying pictures through it would make every listing pay
 * for content almost nobody asked to see. `address` is what a reader hands back to fetch them.
 */
export const TranscriptImageSchema = z.object({
  /** `<entry-uuid>#<block-index>` — stable for the life of the line that holds it. */
  address: z.string().min(1).max(256),
  mediaType: z.string().min(1).max(128).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  /** Of the encoded content, so a reader can tell two pictures apart without fetching either. */
  digest: z.string().length(64).nullable(),
  /**
   * Why the image cannot be fetched, when it cannot. Null means it can. An unreadable image must
   * stay distinguishable from no image at all — that is the whole failure this replaces.
   */
  unavailable: z.enum(['unsupported-source', 'malformed', 'too-large']).nullable(),
});
export type TranscriptImage = z.infer<typeof TranscriptImageSchema>;

/** What a turn spent, exactly as the source reports it. Absent is "unknown", never zero. */
export const TranscriptUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
});
export type TranscriptUsage = z.infer<typeof TranscriptUsageSchema>;

export const TranscriptMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  createdAt: z.string().nullable(),
  role: TranscriptRoleSchema,
  kind: TranscriptKindSchema,
  text: z.string().nullable(),
  title: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  status: z.enum(['error']).nullable(),
  rawType: z.string().nullable(),
  // Tool-card fields: a tool_call's paired tool_result is FOLDED in here so the UI shows one
  // card (request on top, outcome below) instead of two stray lines. `done` = a result arrived
  // (else still running → spinner); `result` = the short outcome ("+12 −3", "248 lines").
  done: z.boolean(),
  result: z.string().nullable(),
  // Full request/response for the EXPANDED tool card: `input` = the tool_use input as pretty
  // JSON (the actual command/args), `resultText` = the paired tool_result's full output. Both
  // clipped to the display text limit; null for non-tool messages / still-running calls.
  input: z.string().nullable(),
  /** The image this message carries, addressed. Null on every other kind of message. */
  image: TranscriptImageSchema.nullable().default(null),
  /**
   * What this answer cost, when the source said. Null is "the source did not say" — a line written
   * before this existed reports unknown, and unknown is not zero tokens.
   */
  usage: TranscriptUsageSchema.nullable().default(null),
  resultText: z.string().nullable(),
});

// Provider-neutral inventory row for a conversation that exists outside ccmux's registry.
// Discovery reports evidence and capabilities separately: a stored rollout is not proof that a
// writer is live, and a writer lock is not proof that a transcript has been persisted yet.
export const ExternalOriginSchema = z.enum([
  'cli',
  'desktop',
  'vscode',
  'exec',
  'app-server',
  'subagent',
  'unknown',
]);
export const ExternalStorageSchema = z.enum(['stored', 'missing', 'unknown']);
export const WriterEvidenceSchema = z.enum(['observed', 'none-observed', 'unknown']);
export const WriterRuntimeKindSchema = z.enum([
  'managed',
  'dedicated-cli',
  'desktop',
  'vscode',
  'app-server',
  'shared',
  'self',
  'unknown',
]);

export const WriterRuntimeSchema = z
  .object({
    kind: WriterRuntimeKindSchema,
    pid: z.number().int().positive().nullable(),
    startTime: z.string().nullable(),
    processGroup: z.number().int().positive().nullable(),
    reason: z.string().min(1),
  })
  .strict();

export const ExternalCapabilitiesSchema = z
  .object({
    inspect: z.boolean(),
    attemptAdopt: z.boolean(),
    fork: z.boolean(),
    terminateAndAdopt: z.boolean(),
    releaseAtSource: z.boolean(),
    reasons: z.array(z.string().min(1)),
  })
  .strict();

export const ExternalSessionSchema = z
  .object({
    key: z.string().min(1),
    plane: z.literal('external'),
    provider: AgentKindSchema,
    host: z.string().regex(RC_PREFIX_RE),
    threadId: z.uuid(),
    dir: z.string().startsWith('/').nullable(),
    path: z.string().startsWith('/').nullable(),
    origin: ExternalOriginSchema,
    storage: ExternalStorageSchema,
    writerEvidence: WriterEvidenceSchema,
    writerRuntime: WriterRuntimeSchema.nullable(),
    turnState: ExternalTurnStateSchema,
    capabilities: ExternalCapabilitiesSchema,
    lastActivityMs: z.number().nonnegative().nullable(),
    lastModel: z.string().nullable(),
    usedTokens: z.number().nonnegative().nullable(),
    lastMessage: TranscriptMessageSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.storage === 'stored' && value.path === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'stored external session requires transcript path',
      });
    }
    if (value.storage === 'missing' && (value.path !== null || value.dir !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage'],
        message: 'missing storage cannot claim transcript path or cwd',
      });
    }
  });

export const ExternalInventoryJsonSchema = z
  .object({
    version: z.string().min(1),
    generatedAt: z.iso.datetime(),
    rcPrefix: z.string().regex(RC_PREFIX_RE),
    sessions: z.array(ExternalSessionSchema),
  })
  .strict();

// Whole-session composition (counted over the ENTIRE JSONL, not just the loaded window),
// so the header reads true totals that don't drift as you scroll/paginate.
export const TranscriptStatsSchema = z.object({
  messages: z.number(), // conversational turns (user + assistant)
  user: z.number(),
  assistant: z.number(),
  toolCalls: z.number(),
  thinking: z.number(),
});

export const TranscriptJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  session: z.object({
    name: z.string(),
    uuid: z.string(),
    rc: z.string(),
    dir: z.string(),
    machine: z.string(),
  }),
  source: z.object({
    kind: z.string(),
    path: z.string(),
    available: z.boolean(),
    error: z.string().nullable(),
  }),
  cursor: z.object({
    opaque: z.string().nullable(),
    line: z.number().nullable(),
    byteOffset: z.null(),
    mtimeMs: z.number().nullable(),
  }),
  // Window bounds of THIS response, for backward pagination (infinite-scroll-up):
  // `firstLine` = absolute line the window starts at, `lastLine` = total lines,
  // `reachedStart` = firstLine reaches line 1 (nothing older to load).
  window: z.object({
    firstLine: z.number(),
    lastLine: z.number(),
    reachedStart: z.boolean(),
  }),
  stats: TranscriptStatsSchema,
  messages: z.array(TranscriptMessageSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * One session event: a TRANSITION, not a state.
 *
 * The distinction is the whole reason this exists. Every outside surface used to learn about
 * sessions by polling `list --json`, which answers "what is true now" — so a turn that started and
 * ended between two polls left no trace, and "this ran for thirty minutes" could not be recovered
 * from two snapshots. A feed of transitions answers that directly, and costs nothing while nothing
 * happens.
 *
 * `id` is the idempotency key, and it is load-bearing rather than decorative: delivery here is
 * at-least-once by construction (a reader reconnecting with `--since` re-reads the boundary, and two
 * writers append independently), so a consumer that ACTS on an event — speaks it, blinks a light —
 * must be able to recognise one it has already handled.
 */
export const SessionEventKindSchema = z.enum([
  'turn-start',
  'turn-end',
  // A session sitting at a blocking menu, and the moment it leaves one. `resumed` exists because the
  // pair is not otherwise closable: answering a permission prompt puts the agent straight back to
  // work WITHOUT a new user turn, so nothing else would ever follow the `waiting`. A reader tracking
  // state would leave that session marked "waiting for you" until its next turn — which can be
  // hours, and reads as a session that needs attention when it needs none.
  'waiting',
  'resumed',
  'session-start',
  'session-stop',
  'session-blocked',
]);

export const SESSION_EVENT_VERSION = 1;

export const SessionEventSchema = z
  .object({
    v: z.number().int().positive(),
    id: z.uuid(),
    ts: z.iso.datetime(),
    // The full address, so a reader never has to resolve anything against its own machine — the
    // mistake fleet addressing exists to remove.
    machine: z.string().regex(RC_PREFIX_RE),
    session: z.string().min(1).regex(SESSION_NAME_RE),
    agent: AgentKindSchema,
    threadId: z.uuid(),
    event: SessionEventKindSchema,
    /** `turn-end` only: how long the turn ran, when its start was observed. */
    durationMs: z.number().nonnegative().optional(),
    /** `turn-end` only: the turn did NOT end voluntarily (interrupted, or the agent died). The hook
     *  never fires for those, so this can only ever come from the supervisor's own observation. */
    interrupted: z.boolean().optional(),
    /** Free-form context for the kinds that have any: which menu a session waits at, why it is
     *  blocked. Never conversation content — that stays in the transcript, behind its own command. */
    detail: z.string().optional(),
  })
  // NOT strict, and that is the point: this record is read by other machines and by outside
  // surfaces, which may be running an older build than the one that wrote it. Strict parsing would
  // turn "a newer ccmux added a field" into "every event after the upgrade is unreadable here" —
  // a fleet-wide silence produced by a version skew nobody would think to check. Unknown keys ride
  // through untouched, so an old `ccmux events --json` still hands a consumer a field only the
  // newer writer understands. Same leniency the fleet's own `list --json` adapter already applies
  // to a peer's answer.
  .loose();

// `list --json` wire shape — the canonical machine-readable contract that
// dashboards/agents (and our own TUI) consume. Decoupled from any downstream
// consumer's own snapshot type ON PURPOSE: duplicated there, never
// cross-imported, so the two evolve independently.
// ─────────────────────────────────────────────────────────────────────────────

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
  context: ContextInfoSchema,
  uptime: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
  // What a restart would change for this session; empty = nothing (or launched before stamping).
  // Deliberately unaffected by `role`: a role is addressing metadata, not launch input, so declaring
  // one must never paint a session as needing a restart.
  stale: z.array(z.string()).default([]),
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
  costUsd: z.number().nullable().default(null),
  /** The env file this session declares (absolute), and whether it exists right now. A declared file
   *  that is missing does not stop the session — the original decision was "raise it and shout", since
   *  a session that will not boot is worse for a supervisor than one variable short — so this is how a
   *  reader finds out at all. Null = nothing declared. */
  envFile: z.object({ path: z.string(), present: z.boolean() }).nullable().default(null),
  createdAt: z.string().nullable(),
  lastMessage: TranscriptMessageSchema.nullable(),
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
});

export const ListJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  rcPrefix: z.string(),
  stateDir: z.string(),
  release: ReleaseStandingSchema,
  sessions: z.array(ListItemSchema),
});
