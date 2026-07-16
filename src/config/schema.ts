import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for every persisted/remote shape. No bare interfaces,
// no `as` — every type below is `z.infer` of one of these schemas (see types.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One managed Claude conversation.
 *
 * The sessions FILE is JSONL — one of these per line. `uuid` is the only identity:
 * pinned once at `new`, never changes, and drives deterministic resume. No PID,
 * no lock, no state file.
 */
export const SessionSchema = z.object({
  // tmux session name. 'cc-' is convention, not enforced. Forbid '|' (legacy
  // delimiter), whitespace, and '#' (comment-line safety in the sessions file).
  name: z
    .string()
    .min(1)
    .regex(/^[^|\s#]+$/, "name: no '|', whitespace, or '#'"),
  // Absolute working dir. Basis for both `cwd` and the history-jsonl path. MUST be
  // absolute or Claude's project-dir encoding won't match (see claude/resume.ts).
  dir: z.string().startsWith("/", "dir must be absolute"),
  // Pinned conversation uuid — the single source of identity for resume.
  uuid: z.uuid(),
  // Per-session extra claude flags, as an ARRAY (never a string). Passed straight
  // to Bun.spawn argv — no shell ever sees them, so e.g. "claude-opus-4-8[1m]" is
  // a plain element and the whole shlex/glob bug class is structurally gone.
  flags: z.array(z.string()).default([]),
  // Parked but kept: stays in the file (history preserved), skipped by ensure/daemon.
  // Lets you stop healing a session without removing it.
  archived: z.boolean().default(false),
  // v2-reserved (rate-limit auto-resume): the text steered to a parked session at
  // reset. Defaulted so v1 ignores it; lives on the record so v2 needs no 2nd file.
  resumeText: z.string().default("continue"),
  // Which agent CLI backs this session. Selects the transcript adapter, the history
  // locator, and (later) the launch binary. Defaulted so every existing session row
  // stays valid and reads as "claude" with no migration.
  agent: z.enum(["claude", "codex"]).default("claude"),
});

/** Agent CLI backing a session — the registry key for transcript adapters. */
export const AgentKindSchema = z.enum(["claude", "codex"]);

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
  // Claude's project-history root; basis for the resume existence check.
  // local: /Users/user/.claude/projects, servers: /root/.claude/projects.
  projectsDir: z.string().startsWith("/"),
  // Codex's rollout-session root — basis for the Codex transcript locator.
  // default: ~/.codex/sessions. Optional; only needed for agent="codex" sessions.
  codexSessionsDir: z.string().startsWith("/").optional(),
  // RC display-name prefix so the phone/Telegram client knows which box a session is on. A
  // free-form lowercase slug (local, dev, prod, staging, …) — see RC_PREFIX_RE. The regex
  // loud-fails on garbage (the real intent), and `install` refuses if it can't be set.
  rcPrefix: z.string().regex(RC_PREFIX_RE, "rcPrefix must be a lowercase slug (e.g. local, dev, prod, staging)"),
  // Sessions data file (env CCMUX_SESSIONS overrides). Per-machine default.
  sessionsFile: z.string().startsWith("/"),
  // Daemon heal period (seconds). Per-machine-tunable, re-read live each loop.
  ensureInterval: z.number().int().positive().default(30),
  // Any Claude Code permission mode (matches `claude --permission-mode` choices).
  // Escalated modes (bypassPermissions/dontAsk) are honored ONLY for non-root daemons:
  // under root, launch.ts downgrades them to "auto" (servers stay guarded — see buildArgv).
  permissionMode: z
    .enum(["auto", "manual", "plan", "acceptEdits", "dontAsk", "bypassPermissions"])
    .default("auto"),
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
  // System-log threshold (~/.ccmux/ccmux.log). Re-read live by the daemon each tick —
  // flip to "debug" on a misbehaving box without restarting anything.
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
// dashboards/agents (and our own TUI) consume. Decoupled from monit ON PURPOSE:
// duplicated there, never cross-imported, so the two evolve independently.
// ─────────────────────────────────────────────────────────────────────────────

/** Live state of a session. working/idle are scraped from the pane; stopped = not running;
 *  external = a live Claude session running OUTSIDE ccmux (discovered, read-only). */
export const SessionStateSchema = z.enum(["working", "idle", "stopped", "external"]);

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
  dir: z.string(),
  uuid: z.string(),
  rc: z.string(),
  running: z.boolean(),
  archived: z.boolean(),
  state: SessionStateSchema,
  model: z.string().nullable(),
  context: ContextInfoSchema,
  uptime: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
  createdAt: z.string().nullable(),
  lastMessage: TranscriptMessageSchema.nullable(),
});

export const ListJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  rcPrefix: z.string(),
  sessionsFile: z.string(),
  sessions: z.array(ListItemSchema),
});
