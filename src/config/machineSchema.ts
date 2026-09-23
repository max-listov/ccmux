import { z } from 'zod';
import { RC_PREFIX_RE, SESSION_NAME_RE } from '../chat/identitySchema.ts';
import { MessageApplicationsSchema } from '../chat/originSchema.ts';
import { AgentPoliciesSchema } from '../policy/schema.ts';
import {
  LaunchRecipeIdSchema,
  MachineLaunchRecipeSchema,
  PermissionModeSchema,
} from './launchSchema.ts';

/*
 * This machine's configuration (`machine.json`) and the release it tracks. Every persisted or
 * remote shape has one schema; its type is `z.infer` of it.
 */

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
  // `ccmux msg host-b:agent-b` possible; absent/empty = fleet addressing simply isn't available here and
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
  /** Provider-neutral local adapter for peers that are not reached through ssh. */
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
  remoteTransport: z
    .object({
      peers: z.array(z.string().regex(RC_PREFIX_RE)).default([]),
      // Absent = the stable generic adapter path under this user's state root.
      socket: z.string().startsWith('/').optional(),
      /** Exact authenticated receiver ancestor. This is deployment data, never provider code. */
      trustedAncestor: z
        .object({
          executable: z.string().startsWith('/'),
          argument: z.string().min(1).max(128),
        })
        .strict()
        .optional(),
    })
    .strict()
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
  // Self-update source (where release.json lives). The bundle it names is downloaded over https
  // only — stitchkit's `applyCliUpdate` refuses any other scheme and private hosts; a local build is
  // tested with `bun run stage` + `ccmux update`. Optional — `update` is a clear no-op when unset.
  releaseUrl: z.url().optional(),
  // A release feed on this machine's own network — a self-hosted mirror, a test — is refused by the
  // download's SSRF boundary unless stated here. Off by default: an asset URL arrives inside a
  // document, and a public feed has no reason to point into the local network.
  releaseAllowPrivateHosts: z.boolean().default(false),
  // Signing keys accepted beside the ones compiled into ccmux (`src/release/trust.ts`), by key id →
  // base64 of the raw Ed25519 public key — for a feed this machine's operator signs.
  releaseTrustKeys: z.record(z.string().min(1), z.string().min(1)).optional(),
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
 *
 * These are the fields every ccmux reads, the install script and earlier daemons included. The same
 * `release.json` is also a signed stitchkit `CliBuildManifest` (`name`, `commit`, `builtAt`,
 * `assets`, `signature`), which is what a current ccmux installs from; `url` and `sha256` here name
 * the same bundle as its assets do.
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
