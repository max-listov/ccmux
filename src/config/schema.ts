import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for every persisted/remote shape. No bare interfaces,
// no `as` — every type below is `z.infer` of one of these schemas (see types.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Any Claude Code permission mode (matches `claude --permission-mode` choices).
 *  Shared by the machine default and the per-session override so the two can't drift. */
export const PermissionModeSchema = z.enum([
  "auto",
  "manual",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
]);

/**
 * Legal tmux session name for ccmux. `:` is excluded on two independent grounds: it separates the
 * machine from the session in a fleet address, and tmux splits a target at the first `:` — a session
 * named with one could never be captured or sent to, so nothing legal is being taken away. (A `.` is
 * fine and stays legal: tmux only treats it as a metacharacter in the `window.pane` part AFTER the
 * colon — verified by creating a dotted session and driving it through `=name:0.0`.)
 */
export const SESSION_NAME_RE = /^[^|\s#:]+$/;

/** Agent CLI backing a managed session. Persisted explicitly on every registry row. */
export const AgentKindSchema = z.enum(["claude", "codex"]);

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
  dir: z.string().startsWith("/", "dir must be absolute"),
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
  resumeText: z.string().default("continue"),
  // Which agent CLI backs this session. It is authoritative routing identity, so it is
  // required on every row and can never be inferred from history, cwd, or a default.
  agent: AgentKindSchema,
  // Per-session permission-mode OVERRIDE. Undefined → inherit the machine default
  // (MachineConfig.permissionMode). Set it to gate ONE session differently from the box
  // default — e.g. the box is bypassPermissions but a client-prod session stays "auto".
  // The root-guard still applies at launch (buildArgv): escalated modes downgrade to
  // "auto" under a root daemon, whether they came from the machine or the session.
  permissionMode: PermissionModeSchema.optional(),
  // Inter-agent chat opt-in. Default OFF so no session sends or receives until you turn it on
  // (`ccmux chat on <name>`) — chat traffic is never implicit. Gates BOTH sending from this
  // session and delivering peer messages to it. Defaulted so existing session rows stay valid.
  chatEnabled: z.boolean().default(false),
  // Named prompt modules composed INTO the injected system prompt (buildPrompt) at every
  // launch/heal, on top of the base management prompt. Each key is resolved against the in-code
  // module registry (agent/promptModules.ts) — the module TEXT is versioned CODE; only the NAME
  // is persisted here, so an updated module reaches every session on its next restart and NEVER
  // goes stale (unlike snapshotting text). Unknown key → loud fail at launch. This is data (a
  // free-form key), not a role enum: a new capability = a new registry entry, no schema change.
  // Today's one module is "router" (the autonomous-manager protocol).
  promptModules: z.array(z.string()).default([]),
});

/** A fresh managed launch that has not yet produced an authoritative provider thread id. */
export const PendingSessionSchema = z.object({
  generation: z.uuid(),
  marker: z.string().regex(/^ccmux_[0-9a-f-]{36}$/),
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create") }),
    z.object({ kind: z.literal("adopt"), sourceThreadId: z.uuid() }),
    z.object({ kind: z.literal("fork"), sourceThreadId: z.uuid() }),
  ]),
  session: SessionSchema.omit({ uuid: true }),
  createdAt: z.iso.datetime(),
  status: z.enum(["pending", "blocked", "promoted"]),
  error: z.string().min(1).optional(),
  uuid: z.uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.status === "promoted" && value.uuid === undefined) {
    ctx.addIssue({ code: "custom", path: ["uuid"], message: "promoted pending session requires uuid" });
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

/** Optional Telegram mirror of the inter-agent chat: forward every message to a bot — a group, a
 *  DM, or a specific forum topic. Any ccmux user drops in their own @BotFather token + target;
 *  absent → no mirroring (fail-soft). Set in machine.json. */
export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1), // @BotFather token (secret)
  chatId: z.string().min(1), // numeric group/DM id (a string — supergroups are negative)
  topicId: z.number().int().positive().optional(), // message_thread_id of a forum topic
});

/** A machine's RC/display-name prefix — a free-form lowercase slug (local, dev, prod, staging, …).
 *  NOT a fixed enum: the fleet grows past 3 machines. This pattern still loud-fails on garbage,
 *  which was the only real value of the old `z.enum(["local","dev","prod"])`. */
export const RC_PREFIX_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Per-machine config: the ONE-artifact / many-configs split. Everything that
 * differs between local/dev/prod lives here, never in code.
 */
export const MachineConfigSchema = z.object({
  // Absolute binaries — differ per machine (ordered-fallback-detected, overridable).
  claudeBin: z.string().startsWith("/"),
  // Codex CLI binary — optional; only required for agent="codex" sessions.
  codexBin: z.string().startsWith("/").optional(),
  tmuxBin: z.string().startsWith("/"),
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
  // local: /Users/user/.claude/projects, servers: /root/.claude/projects.
  projectsDir: z.string().startsWith("/"),
  // Codex's rollout-session root — basis for the Codex transcript locator.
  // default: ~/.codex/sessions. Optional; only needed for agent="codex" sessions.
  codexSessionsDir: z.string().startsWith("/").optional(),
  // Codex state root. Writer locks are sibling state, not derivable from an arbitrary sessions
  // override; ownership admission therefore requires this first-class path.
  codexHome: z.string().startsWith("/").optional(),
  // Bound for a fresh Codex TUI to persist its launch marker before the create transaction fails.
  codexCorrelationTimeoutMs: z.number().int().min(100).default(30_000),
  // RC display-name prefix so the phone/Telegram client knows which box a session is on. A
  // free-form lowercase slug (local, dev, prod, staging, …) — see RC_PREFIX_RE. The regex
  // loud-fails on garbage (the real intent), and `install` refuses if it can't be set.
  rcPrefix: z.string().regex(RC_PREFIX_RE, "rcPrefix must be a lowercase slug (e.g. local, dev, prod, staging)"),
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
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/, "fleet alias must be an ssh host alias (no leading '-', no spaces)"),
    )
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
  stateDir: z.string().startsWith("/"),
  // Daemon heal period (seconds). Per-machine-tunable, re-read live each loop.
  ensureInterval: z.number().int().positive().default(30),
  // Machine-wide DEFAULT permission mode (matches `claude --permission-mode` choices).
  // A session can override it per-session (Session.permissionMode). Escalated modes
  // (bypassPermissions/dontAsk) are honored ONLY for non-root daemons: under root,
  // launch.ts downgrades them to "auto" (servers stay guarded — see buildArgv).
  permissionMode: PermissionModeSchema.default("auto"),
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
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Claude 2.1.x shows a BLOCKING "Resume from summary?" picker on `--resume` of a large/old
  // session; an unattended (daemon-healed) resume would strand at that menu — typed input lands
  // on the MENU, not the conversation, so after a reboot every big session sits dead until a
  // human answers it. The supervisor auto-answers per this policy: "full" = resume full, keep
  // ALL context (default — never lose work); "summary" = resume compacted; "off" = never
  // auto-answer (a human will). Claude-only; other agents have no such picker.
  resumePicker: z.enum(["full", "summary", "off"]).default("full"),
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
  notes: z.string().default(""),
  // verify the artifact bytes BEFORE swapping it in (supply-chain safety).
  sha256: z.string().length(64),
  url: z.url(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inter-agent chat — an append-only message ledger (the source of truth) plus a
// separate cursors file. A message is immutable once written; delivery/read state
// lives in the cursors (single writer = the daemon), never mutated back into the
// ledger. This keeps the ledger a clean, replayable, exportable log for debugging.
// ─────────────────────────────────────────────────────────────────────────────

/** Exact identity of a ccmux-managed runtime. The human selector is machine+session, but an
 * immutable message pins the provider and thread too, so reuse can never redirect queued mail. */
export const ManagedPeerSchema = z
  .object({
    kind: z.literal("managed"),
    source: z.literal("ccmux"),
    machine: z.string().regex(RC_PREFIX_RE),
    agent: AgentKindSchema,
    session: z.string().min(1).regex(SESSION_NAME_RE),
    threadId: z.uuid(),
  })
  .strict();

/** A human/tool invoking ccmux outside a managed session. It has no provider or thread identity. */
export const CliPrincipalSchema = z
  .object({
    kind: z.literal("cli"),
    source: z.literal("ccmux"),
    machine: z.string().regex(RC_PREFIX_RE),
  })
  .strict();

/** Valid senders. Owner authority is provenance, not a spoofable sender route. */
export const ChatPrincipalSchema = z.union([ManagedPeerSchema, CliPrincipalSchema]);

/** The owner is an out-of-band sink, never a fake managed peer. */
export const OwnerTargetSchema = z.object({ kind: z.literal("owner") }).strict();
export const ChatTargetSchema = z.union([ManagedPeerSchema, OwnerTargetSchema]);

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

export const ChatMessageSchema = z.object({
  // First field on the wire and on disk, so a foreign record is identified before anything else is
  // interpreted. `.strict()` below would already reject an older record — but on the shape of
  // `from`, which reads as a bug rather than as "this is from another generation".
  v: z.literal(CHAT_GENERATION),
  id: z.uuid(), // unique per message
  ts: z.string(), // ISO-8601 send time
  from: ChatPrincipalSchema,
  to: ChatTargetSchema,
  body: z.string(),
  task: z.string().nullable(),
  // Deferred delivery: hold until the recipient VOLUNTARILY finishes its turn — delivered by the
  // Stop hook at end-of-turn, or by the daemon once the target is STABLY idle. Never pasted while
  // the target is working (Claude's steering queue would flush it mid-turn — the whole bug this
  // fixes). False means normal peer-chat behavior.
  defer: z.boolean(),
  // Honest provenance for a RELAYED message: who the instruction truly came from (e.g. "owner")
  // when `from` is only the courier (the router). Null → `from` is the real origin. Rendered as
  // "on behalf of <x>" so the recipient sees the true authority WITHOUT `from` ever being spoofed.
  onBehalfOf: z.string().nullable(),
  // Time-delayed delivery: an ISO-8601 instant before which the daemon must NOT deliver this message
  // (skipped while now < notBefore). Powers a router's self-`watchdog` (`msg <self> --after N`) so it
  // wakes on a TIMER, not only on an inbound reply — the backbone of "the router finishes the job on
  // its own". Null → deliver as soon as eligible. A defer message can also carry notBefore (both must
  // hold). `defer || notBefore !== null` makes a message CONDITIONAL — delivered by id, off the
  // in-order cursor, so it never head-of-line-blocks immediate mail.
  notBefore: z.string().nullable(),
}).strict();

/** Delivery/read bookkeeping, kept OUT of the append-only ledger. `read[managedPeerKey]` = the ledger
 *  LENGTH a recipient has read its inbox up to (unread = TO-me messages at/after that index).
 *  Grows with delivery sinks (pane/telegram) in later phases; the daemon is the single writer. */
export const ChatCursorsSchema = z.object({
  read: z.record(z.string(), z.number()).default({}),
  // per-recipient: ledger LENGTH the daemon has PUSH-delivered a session's inbox up to. Distinct
  // from `read` (advanced by `ccmux inbox` too) so a push and a manual pull don't double-count.
  // The daemon is the sole writer; survives restarts so a bounce never re-pushes old messages.
  delivered: z.record(z.string(), z.number()).default({}),
  // Telegram mirror progress: ledger LENGTH mirrored to the bot (a BROADCAST sink — every message,
  // in order). Persisted so a restart resends only the un-mirrored backlog, never the whole history.
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

export const TranscriptRoleSchema = z.enum(["user", "assistant", "tool", "system", "unknown"]);
export const TranscriptKindSchema = z.enum(["message", "tool_call", "tool_result", "thinking", "event", "unknown"]);

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
  status: z.enum(["error"]).nullable(),
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
  resultText: z.string().nullable(),
});

// Provider-neutral inventory row for a conversation that exists outside ccmux's registry.
// Discovery reports evidence and capabilities separately: a stored rollout is not proof that a
// writer is live, and a writer lock is not proof that a transcript has been persisted yet.
export const ExternalOriginSchema = z.enum(["cli", "desktop", "vscode", "exec", "app-server", "subagent", "unknown"]);
export const ExternalStorageSchema = z.enum(["stored", "missing", "unknown"]);
export const WriterEvidenceSchema = z.enum(["observed", "none-observed", "unknown"]);
export const WriterRuntimeKindSchema = z.enum([
  "managed",
  "dedicated-cli",
  "desktop",
  "vscode",
  "app-server",
  "shared",
  "self",
  "unknown",
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
    plane: z.literal("external"),
    provider: AgentKindSchema,
    host: z.string().regex(RC_PREFIX_RE),
    threadId: z.uuid(),
    dir: z.string().startsWith("/").nullable(),
    path: z.string().startsWith("/").nullable(),
    origin: ExternalOriginSchema,
    storage: ExternalStorageSchema,
    writerEvidence: WriterEvidenceSchema,
    writerRuntime: WriterRuntimeSchema.nullable(),
    capabilities: ExternalCapabilitiesSchema,
    lastActivityMs: z.number().nonnegative().nullable(),
    lastModel: z.string().nullable(),
    usedTokens: z.number().nonnegative().nullable(),
    lastMessage: TranscriptMessageSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.storage === "stored" && value.path === null) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "stored external session requires transcript path" });
    }
    if (value.storage === "missing" && (value.path !== null || value.dir !== null)) {
      ctx.addIssue({ code: "custom", path: ["storage"], message: "missing storage cannot claim transcript path or cwd" });
    }
  });

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
// `list --json` wire shape — the canonical machine-readable contract that
// dashboards/agents (and our own TUI) consume. Decoupled from any downstream
// consumer's own snapshot type ON PURPOSE: duplicated there, never
// cross-imported, so the two evolve independently.
// ─────────────────────────────────────────────────────────────────────────────

/** Live state of a session. working/idle are scraped from the pane; stopped = not running;
 *  external = a live Claude session running OUTSIDE ccmux (discovered, read-only). */
export const SessionStateSchema = z.enum(["working", "idle", "stopped", "blocked", "external"]);

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
  lifecycleError: z.string().nullable(),
  model: z.string().nullable(),
  context: ContextInfoSchema,
  uptime: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
  // What a restart would change for this session; empty = nothing (or launched before stamping).
  stale: z.array(z.string()).default([]),
  createdAt: z.string().nullable(),
  lastMessage: TranscriptMessageSchema.nullable(),
});

export const ListJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  rcPrefix: z.string(),
  stateDir: z.string(),
  sessions: z.array(ListItemSchema),
});
