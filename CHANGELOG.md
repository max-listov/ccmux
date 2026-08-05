# Changelog

All notable changes to ccmux. The `[Unreleased]` section accumulates as work lands;
`bun run release X.Y.Z "notes"` rolls it into a dated version section, and CI publishes
the GitHub Release with that section as the notes.

## [Unreleased]

## [0.9.2] — 2026-08-05

Telegram mirror: bracketed route header with air under it
## [0.9.1] — 2026-08-05

turning the Telegram mirror on starts a live feed, not a history replay

fix: the fleet no longer lags a release behind a CDN cache

`ccmux update` sent `cache-control: no-cache` when fetching the release manifest, and the edge in
front of it ignored that: measured on a live host minutes after publishing, the header returned the
PREVIOUS version while the same URL with a query string returned the new one. Every release reported
"already on latest" on the first try, and auto-update would have held the whole fleet back the same
way. The manifest URL now carries a unique cache key.

Telegram mirror: the route line is now a bracketed header — `[dev:worker → prod:api] · task` — with a
blank line before the body, so on a phone the two stop running together. Mail to the human keeps the
same shape (`📩 [prod:api → you]`) rather than inverting the sentence: one route line to learn to read.

fix: turning the Telegram mirror on starts a live feed instead of replaying history

Enabling the mirror on a machine that already had chat history instantly re-sent all of it: the
progress cursor defaulted to `0`, which made every message ever written an "un-mirrored backlog".
Configuring a bot on two servers dumped 25 old messages into the chat. The cursor is now `null`
until the mirror first runs on that machine, and the first run adopts the present as its starting
point and sends nothing — a mirror is a feed of what happens next, not an archive replay. Existing
cursor files hold a number and are unaffected.
## [0.9.0] — 2026-08-05

prompt speaks in addresses; the Telegram mirror can cover the whole fleet

fix: the two places where ccmux itself pushed agents back to the old way

- **The hand-off block in the injected prompt never showed an address.** It said `wait <session>`
  while `<machine>:<session>` lived in a *different* block, so a cross-machine hand-off required an
  agent to join two halves by itself. It didn't: 1m51s after restarting onto that prompt (its launch
  stamp proves which prompt it had), a session wrapped everything in `ssh` again — the task arrived
  anonymous, the initiator kept no record, and the peer had no way to reply. Addresses now appear in
  every example, `ccmux fleet` is named as the way to discover one, and the ssh wrapper is banned
  **with its consequence** spelled out.
- **The polling ban described one shape instead of the substance.** It forbade "sleep + `ccmux list`
  + grep/awk"; the agent polled a *database* for a byte count, which that sentence doesn't cover — so
  it obeyed the words while doing the forbidden thing. It now bans deciding "done" by polling
  anything at all, naming pane, database, files and sizes.
- The chat block's duplicate of that recipe is **removed** — the knowledge lives in one place.
- **The Telegram mirror can now cover the whole fleet.** Every mirrored line is written as a fleet
  address (`dev:worker → prod:api`) instead of a bare name, because with several machines in one chat
  the same session name commonly exists on two boxes — the very ambiguity addressing exists to
  remove. Enabling it on each machine is config only: cursors are per-machine, so nothing is
  coordinated and nothing double-sends.
## [0.8.0] — 2026-08-05

list tells you which sessions a restart would actually change

feat: `ccmux list` now tells you which sessions a restart would actually change

- Everything that shapes an agent — its system prompt, the chat wiring, the permission mode, the
  supervisor code — is injected **at launch**, so a change lands only on the next restart. ccmux said
  so at the moment you acted (`applies on: ccmux restart …`), but a line that scrolls away is not a
  state you can check an hour later: which sessions were already restarted lived in someone's head.
- Each launch now records what it used, and `list` / `fleet` compare it against what a launch right
  now would produce. The new `RESTART` column names *what* differs — `code`, `chat`, `mode`,
  `modules`, or `config` — and is empty when a restart would change nothing.
- Deliberately **not** a version comparison, which lies in both directions: a release that didn't
  touch the prompt would flag every session for nothing, while `ccmux chat on` doesn't move the
  version at all yet certainly requires a restart.
- A forked conversation is not a config change (the re-pinned uuid is normalised out), and a session
  with no record yet shows nothing — unknown is never displayed as stale.
## [0.7.0] — 2026-08-05

cross-machine mail that couldn't leave is re-sent when transit returns

feat: cross-machine mail that couldn't leave is now re-sent when transit returns

- Transit between servers is **intermittent by design** — there are no server-to-server keys, so a
  machine can only reach another while the owner's forwarded key is present. A send attempted in a
  gap failed, and the honest `[NOT SENT — transport failed]` row was where it ended: an agent
  reported, moved on, and its report sat on disk while a peer waited for it. Observed live.
- The record is now a **queue that drains itself**. The daemon re-sends failed `msg` rows from the
  outbox — bounded to a one-hour window and a few attempts per tick, and never for `restart --then`
  (a hand-off is an action, not a letter).
- Safe because the send became **idempotent**: the message id travels with it, and a receiver
  ignores an id it already stored. A retry cannot duplicate — not even in the nasty case where the
  first attempt did land and only the sender read it as a failure. An older ccmux ignores the
  variable and behaves exactly as before.
- `chat log` stops reporting *NOT SENT* for something that arrived later; it says *sent later, on
  retry*. Optional `transitPreflight` (argv array in `machine.json`) runs once before a batch of
  retries for fleets that can restore transit locally — generic, off by default.
- **The key model is untouched.** Nothing gains access to anything; the fix is to survive the link
  being down, not to keep it up.
## [0.6.1] — 2026-08-05

a session could go permanently deaf to chat — ccmux was typing into it

fix: a session could go permanently deaf to chat — because ccmux was typing into it

- **`_run` no longer mirrors its log to stderr.** The in-pane supervisor shares a terminal with the
  agent it supervises, so a structured log line printed straight into that agent's UI and landed in
  its **input buffer** (verified: a keystroke sent to the pane edited the line in place). The
  "composer occupied" delivery gate then held every message for that session **forever**, reporting
  the reason as "a human is typing" when nobody was there. Found on a live cross-machine run; the
  gate itself is untouched — it was right, the pollution was ours. Every record still goes to
  `~/.ccmux/ccmux.log`; a failed spawn now says so in the pane as a plain sentence.
- **`ccmux wait` no longer races the message you just sent.** Delivery happens a beat after `msg`
  returns, so a `wait` fired immediately saw an idle pane and reported a finished turn that had
  never begun — in under a second, in the exact recipe we recommend. A session with undelivered mail
  is no longer considered settled.
- **`chat on|off`, `router on|off` and `inbox` accept a fleet address** like every other verb that
  operates on an existing session. Without it both a human and an agent fell back to raw `ssh`,
  which is what addressing exists to remove.
## [0.6.0] — 2026-08-05

fleet addressing — <machine>:<session> as a first-class agent address, with the return address and the whole exchange visible

feat: fleet addressing — `<machine>:<session>` as a first-class agent address, with the return address and the whole exchange visible

A session name only means something on one machine. Two boxes can each have an `api`, so a bare name
handed across a fleet is ambiguous — and an agent that resolves it locally reports to a stranger
while the one waiting hears nothing, with exit 0 the whole way. That happened, and it cost hours to
reconstruct because each machine's log knew only half of it.

- **Address.** `ccmux msg host-b:api "…"` — and the same for `start`, `stop`, `restart`, `rm`,
  `send`, `mode`, `logs`, `transcript`, `wait`. A bare name still means "here", unchanged. The
  machine label is the `rcPrefix` you already gave that box; a `fleet` map in `machine.json` points
  each label at an ssh alias. A remote send is **enqueued on the receiving machine** through its own
  `ccmux msg`, so it inherits every existing guarantee — menu/typing protection, rate limits, the
  ledger. `ccmux doctor` verifies each alias really is the machine it claims (and flags a label that
  duplicates this machine's own prefix, which could never be reached).
- **Return address.** Incoming cross-machine mail carries the sender's full address and, when this
  machine can actually answer, the exact reply command. A dispatched `restart --then` note is stamped
  the same way — that was the incident's original vector, arriving as anonymous text. The sender's
  address travels as an environment variable, not a flag: an older ccmux ignores an unknown variable,
  whereas an unknown flag was swallowed into the message body and destroyed the text (reproduced
  against the released parser). Both halves of the label are validated, so it cannot forge the
  `[chat from …]` tag it is rendered into.
- **Both halves of the exchange are visible.** `ccmux fleet` lists every session on every machine,
  each line a usable address. `ccmux chat log` now shows what this machine SENT as well as what
  arrived — including sends that never left — and `--fleet` merges every machine's log into one
  time-ordered stream. `ccmux inbox` names *why* a message hasn't landed (recipient stopped, chat
  off, scheduled, waiting for the turn to end, a human typing, rate-limited, or an agent that cannot
  receive chat at all) instead of an unexplained silence.
- Fixes along the way: a delivered `--defer` message no longer shows as pending forever; `inbox` no
  longer advances another session's read cursor; `restart <name>` on an unknown session exits 1
  instead of claiming success; unreachable machines are reported and never fatal.
## [0.5.1] — 2026-08-03

chat delivers while you watch a session — hold only while a human is typing

fix: watching a session no longer blocks its chat — delivery holds only while a human is actually TYPING

- Chat delivery was gated on "is a client attached to this pane", so simply watching a session with
  `tmux a` silenced its inbox **for as long as you stayed attached** — a letter sat undelivered while
  the daemon logged the hold every 3s and the sender had no idea why. Attached is not the hazard.
- The real hazard is narrow: injection appends a literal and presses Enter, so a human's *half-written
  line* would get our text glued onto it and sent. That is now what's tested — an occupied composer
  (the `❯` line in the pane's bottom frame, scanned only near the bottom so past messages, which
  Claude also prefixes with `❯`, are never read as live input), or a keystroke within the last 3s
  (`client_activity`, bridging the gap between two keys). Neither → **deliver, even while attached.**
- The selection-menu hold is untouched: injecting there would pick an option the agent never chose.
- Hold reasons are now named in the log ("human is typing" / "typed a moment ago") instead of the
  blanket "human attached".
## [0.5.0] — 2026-08-03

restart --all (TUI R), ccmux wait, transcript --last-message, self-explaining chat on

feat: `restart --all` (+ TUI `R`), `ccmux wait`, `transcript --last-message`, and a `chat on` that tells you what's next

- **`ccmux restart --all`** (TUI: `R`, behind a confirm) bounces every session on the machine so a
  changed rule set / MCP config / ccmux release lands everywhere at once. The sweep runs in a detached
  driver and restarts sessions **strictly one at a time** — killed and started before the next is
  touched — so the tmux server never empties (it dies with its last session, dropping attached clients)
  and the daemon never sees a fleet-wide outage. It follows conversation forks before each restart,
  waits for the old agent process to actually exit (no two-writer fork), skips archived sessions, does
  the calling session last, and refuses to run twice at once.
- **`ccmux wait <name>`** blocks until a session voluntarily finishes its turn — exit `0` settled,
  `2` timed out (`--timeout N`, default 300s), `1` unknown/stopped. It reuses the exact readiness test
  deferred chat delivery uses, so the two can never disagree, and needs no chat: any script can wait
  for an agent instead of polling `ccmux list` in a loop.
- **`ccmux transcript <name> --last-message`** prints just the agent's final answer as plain text, in
  full (`list --json` carries it clipped to 280 chars) — the "take the report" gesture in one command.
- **`ccmux chat on`** now says `applies on: ccmux restart <name>` (matching `router on`) plus the next
  step, closing the trap where chat was enabled, nothing appeared to happen, and the reason — the hook
  and framing are wired at launch — was invisible.
- README gains a **Coordinating agents** recipe (enable → restart → hand off → `wait` → take the
  report), including the explicit "chat is machine-local, keep orchestrator and workers on one host".
## [0.4.0] — 2026-07-30

Claude session status from structured sources (statusLine JSON + hooks), not pane-scraping

feat: Claude session status from structured sources (statusLine JSON + hooks), not pane-scraping

- Context %, model and cost now come from the STRUCTURED JSON Claude Code feeds its statusLine command
  (`context_window.used_percentage` × `context_window_size`), captured by an injected statusLine
  wrapper that ALSO runs the user's own statusline unchanged (or renders a minimal `model · ctx%`
  default if they have none). This removes the regex-over-rendered-text scrape and its dependency on
  the user's statusline FORMAT, so context % now works on default Claude Code and any user's setup —
  not only a bespoke statusline — with no hardcoded model→window map (the window size comes from Claude).
- Turn-boundary hooks (UserPromptSubmit/Stop/SessionStart) write a per-session working/idle lifecycle
  file. Working/idle display stays pane-decisive (the spinner is reliable and, unlike the hooks, reads
  idle correctly right after an ESC-interrupt); the hook fills only the cold-start gap and `SessionStart`
  clears a stale `working`. The lifecycle file is the substrate for future event-driven push/"waiting".
- Both inject via `--settings` and coexist with the chat Stop hook; status files live under
  `~/.ccmux/status/` and are cleared on stop/rm/restart. Fully fail-open — a status/statusline hiccup
  can never wedge a turn or corrupt the rendered bar.
## [0.3.0] — 2026-07-30

Codex launch/resume (close the launch gap) + shell completions

feat: Codex launch/resume (close the launch gap) + shell completions

- **Codex sessions now launch and resume through ccmux**, 1:1 with Claude as far as the Codex CLI
  allows. Codex has no `--session-id` (a fresh session mints its own rollout id) and no
  `--append-system-prompt`, so: the first launch injects the ccmux management instructions as the
  leading positional PROMPT, and a new `detectFork` reconciles Codex's self-assigned id back into the
  registry through the SAME follow-fork pipeline Claude uses — after which `codex resume <uuid>` tracks
  the real conversation (no prompt re-injected on resume). RC has no Codex equivalent (that's a
  claude.ai feature), so it stays Claude-only. The root daemon strips Codex's `--dangerously-bypass-*`
  switches, mirroring the Claude root guard.
- **`ccmux completions <bash|zsh|fish>`** — prints a shell completion script generated from the same
  `COMMANDS` registry `ccmux help` uses, so a new/renamed verb can never drift from what completes.
- Test coverage filled in for the transcript adapters (Claude tool-call folding + Codex response items),
  the `list` context-label parse, and the TUI width/wrap primitives.
## [0.2.1] — 2026-07-29

model from transcript (source of truth), not the statusline whitelist — a new Claude family (Fable/Mythos) is never shown as a blank model again

fix: session model is read from the transcript (source of truth), not scraped from the statusline against a family whitelist — so a new Claude family (Fable, Mythos, …) is never shown as a blank model again

- `ccmux list` reported `model: null` for sessions on any family the pane scraper hadn't been taught.
  The model was matched with a `(Opus|Sonnet|Haiku)` regex against the rendered statusline — a
  whitelist that silently dropped Fable 5 (and would drop the next family too), and that depended on
  the user's arbitrary custom statusline and reflected the start-time model, not the current one.
- The model now comes from the transcript's `message.model` (Claude) / `turn_context.model` (Codex) —
  the source of truth, always fresh, format-independent. `<synthetic>` turns are skipped and only real
  assistant turns are trusted (image-gen model ids live in tool payloads). Display formatting is a pure
  transform (`prettyModel`: `claude-fable-5` → "Fable 5"), never a lookup table, so a future family
  renders with zero code change; anything off-shape falls back to the raw stripped id.
- The pane scraper keeps only genuinely-live signals (working/idle, best-effort context); its old
  double-duty "model → booted" gate is replaced by a statusline-independent `ready` marker. The
  managed-list and external-discover paths now share one model source and one formatter.

fix: shipped bundle is truly self-contained — stub react-devtools-core at build time so a cache-cleared / offline machine no longer dies on start with ENOENT; + guard test against future hoisted externals

- Fix the shipped bundle silently depending on the global bun cache / npm at startup. ink imports an
  optional DEV-only React DevTools client (`react-devtools-core`) via a HOISTED static import, so it
  loaded on every launch — and built with `--external` it resolved that import at runtime against
  `~/.bun/install/cache` (or an npm auto-install). A machine whose cache was cleared, or that had no
  network, died on start with `ENOENT ... react-devtools-core` — the daemon (and every session it
  supervises) down. The "self-contained" bundle was never actually self-contained. The build now
  compiles an inert stub in its place (`Bun.build()` API + a resolve plugin instead of the
  `bun build --external` spawn), so the single-file bundle carries no external import and starts
  offline / with an empty cache. The bundling moved to `scripts/bundle.ts` (one build path shared by
  stage / CI / release), the misleading "never reached in prod" comment and the obsolete "build only
  outside the project tree" caveat are gone, and a guard test builds via that same path and asserts
  the bundle starts under a wiped cache + dead registry — so this can never silently regress.
## [0.1.19] — 2026-07-25

session-reader library seam — expose the tested block-parser as 'ccmux/session-reader' for external consumers (readSession/parseSession/detect + types), lean (no ink/react), inert for the fleet bundle

- Expose the transcript reader as a library — `ccmux/session-reader` (`src/lib.ts` + a package.json
  `exports` subpath). `readSession(path, agent, textLimit?)` / `parseSession(lines, agent, textLimit?)`
  / `detect(lines)` plus the `TranscriptMessage` types, so an external consumer reuses the tested,
  agent-agnostic (Claude + Codex) block-parser instead of duplicating it. `textLimit` is a passthrough
  (default 6000; pass higher for full-text indexing). Lean by construction: the seam wires only the
  PURE parsers + `readLines` + types, so importing it pulls in `zod` + `node:fs` — not ink/react/tmux
  (verified: `src/lib.ts` bundles to ~15 KB with zero ink/react in the subgraph). Inert for the fleet:
  the shipped bundle is built from `cli.ts`, and `exports` only affects external `import "ccmux/…"`
  resolution. The format sniff moved to `src/agent/detect.ts` (normalize-only deps) and is re-exported
  from `agent/index.ts` under its existing name.
## [0.1.18] — 2026-07-24

fix: 'ccmux update --check' is now read-only and a stale/older staged bundle can't silently downgrade a machine

- Fix `ccmux update --check` mutating the machine. With a leftover staged bundle present (a forgotten
  `bun run stage`), `--check` applied it instead of just reporting — and applied it even when it was
  OLDER than the running version, silently downgrading. Two root fixes: (1) the update decision is now
  a pure `decideUpdate` that `--check` can only ever ask for a `print` from — read-only by
  construction; (2) a staged bundle wins only when NEWER-or-equal than the running version (an
  unreadable one counts as not-newer) — a stale/older staged build is refused as a downgrade unless
  `--force`, with a message pointing at the forgotten file. The legit "test a newer build locally"
  path is unchanged.
## [0.1.17] — 2026-07-24

chat-layer follow-ups from acceptance testing: cancellable watchdogs (msg cancel + --task dedup), honest single-source usage, stdin body, --after+--defer trap warning

- `ccmux msg cancel <task>` — drop a sender's still-undelivered mail for a task (an armed `--after`
  watchdog or a queued `--defer` that hasn't fired). Cancellation is a tombstone in the append-only
  ack-log (`by: "cancel"`), the same log the daemon and the Stop hook already consult — so a cancel
  suppresses delivery in BOTH channels with no new coordination surface and no ledger rewrite.
  Scoped to the sender, so a session can never cancel another's dispatch; already-delivered mail
  can't be un-sent.
- Watchdog dedup by task: re-arming a conditional (`--defer`/`--after`) with the same
  `(sender, recipient, task)` now REPLACES the sender's prior undelivered one instead of piling up a
  duplicate ping — closing the router's "two identical watchdogs both fired" gap. Immediate mail is
  never replaced (it's delivered at once).
- `--after` + `--defer` now prints a note on send: the two multiply to "not before T AND only at a
  turn boundary", so a self-watchdog armed that way won't arrive on time in a long turn — a watchdog
  should use bare `--after` (delivered between tool calls). Not blocked; the flags are compatible.
- `ccmux msg` reads the body from stdin (`echo "…" | ccmux msg <to>`) when no inline text is given
  and stdin isn't a TTY — matching the rest of the toolchain.
- `ccmux msg --help` now shows the full flag set (`--defer`/`--after`/`--on-behalf-of`/`cancel`). The
  short help and the arg-error usage were two separate strings that had drifted; they now render from
  one source, so they can't diverge again.
- `ccmux inbox` help clarifies it's the fallback for held/offline mail, not an archive — a message
  already pushed into a pane doesn't sit there.
- Diagnostic: the daemon now logs when it HOLDS a pending message solely because a human is attached
  to the recipient's pane (delivery resumes on detach) — so "the message never arrived" is traceable
  to that transient cause instead of looking like a broken chat.
## [0.1.16] — 2026-07-24

inter-agent deferred chat + autonomous router sessions + time-delayed watchdog delivery

- Deferred chat delivery: `ccmux msg <to> --defer` holds a follow-up until the recipient
  VOLUNTARILY finishes its turn, then delivers it as if a human typed it — never interrupting
  mid-work (Claude's native queue is steering; it flushes between tool calls). Delivered by a
  Claude Stop hook the instant the turn ends, or by the daemon once the target is stably idle
  (spinner off + assistant-message-last + transcript quiet for a grace window). The Stop hook is
  auto-provisioned at launch, merged into a single `--settings` object (verified it does not
  clobber the user's own hooks). Coordination is an append-only ack-log keyed by message id —
  the daemon stays the sole writer of the delivery cursor, so there is no lost-update race and no
  `block`-loop.
- Router sessions — an autonomous manager. `ccmux new <name> <dir> --router` / `ccmux router
  on|off <name>` gives a session a versioned "manager protocol": it routes an owner-dictated
  follow-up to the right target with `--defer`, waits, validates the result against a stated
  done-criterion, re-asks on a gap (bounded), and escalates to the human ONLY when genuinely
  stuck — never nagging with "continue?". Activated via a `promptModules` data field (a key into
  an in-code module registry, resolved fresh at every launch — no stale snapshot), so it's a
  capability toggle, not a persisted role.
- Time-delayed delivery: `ccmux msg <to> --after <sec>` (a `notBefore` instant). A router arms a
  self-`watchdog` per dispatch, so a target that finishes but never reports back no longer hangs
  it — the timer returns control, the router checks the transcript and closes or escalates on its
  own. Delivery is now two-track — immediate mail flows in order through the cursor, while
  deferred / time-delayed mail is delivered by id off the cursor, so a pending conditional message
  never head-of-line-blocks an immediate reply behind it.
- Honest relay provenance: `ccmux msg --on-behalf-of <who>` renders "on behalf of <who>" so a
  router can carry the owner's authority without ever spoofing the sender — gated so only a router
  (or the cli) may relay, never a plain peer.
- Owner-language: sessions reply to `owner` in the owner's own language by default; an optional
  `ownerLang` in machine.json forces a fixed language.
## [0.1.15] — 2026-07-19

inter-agent chat (menu-safe pane delivery + one-way Telegram mirror) + isolated dev instance

- Isolated dev instance: run a full second ccmux (daemon + sessions + chat) beside prod on one
  machine, fully isolated — a `tmuxSocket` config scopes every tmux call to its own server (`-L`),
  `CCMUX_HOME` overridable for its own app/log/boot-state, `remoteControl:false` keeps its sessions
  out of the claude.ai app. tmux doesn't propagate env into panes, so `new-session -e` pins the
  instance's `CCMUX_HOME/CONFIG/SESSIONS`, and the injected prompt teaches the instance's own cli
  (not the prod shim) when `CCMUX_HOME` is non-default. Scaffold + teardown via `scripts/dev-instance.sh`.
- Inter-agent chat, sender identity: the sender is automatic and unspoofable — an agent sends as its
  own session, a command-line invocation as `cli`; there is no `--from`. `owner` is a reserved
  recipient (the human — Telegram-only, no pane); the injected prompt frames `[chat from owner|cli]`
  as the human side (user-level trust) vs `[chat from <peer>]` as a fellow agent.
- Dev daemon hot-reload: `bun daemon:watch` (= `bun --watch src/cli.ts daemon`) restarts the
  process on any source change — fresh timers each time, unlike `--hot`, which re-runs the entry
  WITHOUT tearing down the old `ensure`/chat loops (they'd accumulate; proven with a `Bun.sleep`
  probe). The boot-loop guard is now skipped when running from live source (`IS_DEV`): it protects
  the auto-updated prod bundle (revert to `.bak`), has no bundle to revert in dev, and would only
  churn false "boot-loop" errors under rapid `--watch` restarts.
- Telegram chat mirror: the routing header (`from → to`, or `📩 for you — from …` for a message to
  the human) is now bold (HTML parse_mode) so who-is-talking-to-whom reads at a glance; the message
  body is HTML-escaped so `<`/`>`/`&` render verbatim and never trip a 400 that would drop the message.
- Inter-agent chat: opt-in messaging between managed sessions. `ccmux msg <to> "..."` /
  `ccmux inbox` / `ccmux chat log|on|off`, with a per-session `chatEnabled` flag (default off).
  The daemon push-delivers into the recipient's pane on a fast cadence, tagged `[chat from X]`
  (framed to the agent as a peer, not the user), gated so it never injects at a selection menu
  (would auto-pick an option — proven live) or while a human is attached; a busy recipient just
  gets it queued at its next turn boundary. In-order per recipient, no double-push across daemon
  bounces; loop/rate guards cap a runaway A→B→A. An append-only ledger (`~/.ccmux-chat.jsonl`) is
  the source of truth; multi-line bodies deliver via bracketed paste. Optional one-way Telegram
  mirror (`telegram` in machine.json → group/DM/topic; fail-soft, outbound only).
## [0.1.14] — 2026-07-19

auto-answer Claude's resume-from-summary picker so daemon-healed reboots don't strand large sessions at the menu

- Auto-answer Claude's blocking "Resume from summary?" picker on an unattended resume. Claude
  2.1.x shows this menu on `--resume` of a large/old session; a daemon-healed reboot had nobody
  to answer it, so big sessions stranded at the menu (typed input — app or tmux — landed on the
  menu, not the conversation) until a human manually restarted each one. The `_run` supervisor now
  watches the freshly-resumed pane and answers per a new `resumePicker` machine-config policy
  (`full` = keep all context [default] · `summary` = compact · `off` = leave for a human). It reads
  the option NUMBER from the pane (robust to reordering) and confirms with Enter only if the number
  key didn't. Claude-only; other agents have no such picker.
## [0.1.13] — 2026-07-17

injected prompt teaches bare ccmux shim, not the absolute bun path

- The sibling-management prompt injected into each session now teaches the bare `ccmux`
  command (the PATH shim) instead of an absolute `bun …/ccmux.js` path, so fleet agents
  call it cleanly. Falls back to the absolute invocation only when the shim isn't
  installed. The machine re-execs (supervisor, boot unit, restart-worker) stay absolute.
## [0.1.12] — 2026-07-17

per-session permission-mode override

- Sessions get an optional `permissionMode` that overrides the machine-wide default
  (`MachineConfig.permissionMode`). Undefined → inherit the machine default, so existing
  sessions and configs are unchanged. Lets one box run bypass by default while a specific
  session (client-prod, untrusted-input) stays gated at `auto`/`plan`.
- New `ccmux mode <name> <mode|default>` sets/clears the override (`default` = inherit the
  machine default). It's a launch-time flag → `ccmux restart <name>` applies it.
- The root-guard is unchanged and still applies to the resolved mode: under a root daemon,
  escalated modes (`bypassPermissions`/`dontAsk`) still downgrade to `auto`, whether they came
  from the machine or the session.
## [0.1.11] — 2026-07-16

transcript whole-session composition stats

- transcript: whole-session `stats { messages, user, assistant, toolCalls, thinking }` on every
  `--json` response, counted over the ENTIRE JSONL (not just the loaded window) and cached by
  mtime — idle sessions cost nothing, active ones recompute only when they move. Lets a viewer
  show true session composition that doesn't drift as you paginate.
## [0.1.10] — 2026-07-16

transcript backward pagination — infinite-scroll-up

- transcript: backward pagination for infinite-scroll-up. `transcript --json --before <line>
  --limit <n>` returns the `n` lines ending just before `<line>` (line-based, so it's robust to
  lines that carry no message — blank / folded tool_result), and every response now carries
  `window { firstLine, lastLine, reachedStart }` so a consumer can page older until line 1.
  `parse` gained an optional `endLine` upper bound (claude + codex parsers).
## [0.1.9] — 2026-07-16

transcript: full tool input + result output for the expanded card

- transcript: `TranscriptMessage` gains `input` (the tool_use input as pretty JSON — the actual
  command/args) and `resultText` (the paired tool_result's full output), both clipped to the
  display text limit. Consumers can now render a real request→response body per tool call
  instead of only the one-line summary. Claude + Codex parsers emit both; null for non-tool
  messages and still-running calls.
## [0.1.8] — 2026-07-14

release pipeline v2 — CI-only publishing

- Release pipeline v2: releases are born only from tags via CI (gate: typecheck + tests +
  bundle smoke); local `--publish` removed; `bun run release X.Y.Z "notes"` is the one
  ceremony (clean-tree guard → check → bump + changelog → commit → tag → push).
- Pre-push git hook runs `bun run check` (wired via `core.hooksPath`).
## [0.1.7] — 2026-07-14

- Follow the fork: the registry re-pins a session to the new session id when Claude Code
  forks the conversation (out-of-context continuation) — previews, transcripts, activity
  and the next restart follow the live conversation instead of a dead file.
- External discovery ignores processes living inside managed panes (a fork leaves the
  pane's stale `--resume` argv looking like a live external session showing a dead
  conversation).
- TUI: fleet sorts by last conversation activity (minute-bucketed, no per-tick reshuffle);
  cards show the activity age (`5m ago`) next to uptime; selection follows the session
  (uuid), not the list position.

## [0.1.6] — 2026-07-11

- Configurable permission mode (all Claude Code modes) in machine.json; escalated modes
  are downgraded to `auto` under a root daemon (server safety guard).

## [0.1.5] — 2026-06-24

- `rcPrefix` is a free-form slug, not a `local|dev|prod` enum — the fleet grows past
  three machines.

## [0.1.4] — 2026-06-23

- Discover live external sessions by process (ps scan), not file mtime — a desktop-app
  open no longer surfaces dead sessions as live.

## [0.1.3] — 2026-06-22

- Add the bun bin dir to the daemon PATH (defense-in-depth for auto-update).

## [0.1.2] — 2026-06-22

- Fix daemon auto-update preflight (bare `bun` not in the launchd PATH).

## [0.1.1] — 2026-06-22

- Fix `ccmux install` ignoring `--release-url` over an existing config.

## [0.1.0] — 2026-06-22

- First public release: persistent self-healing Claude Code tmux sessions with
  deterministic resume, fleet daemon, TUI, GitHub Releases auto-update.
