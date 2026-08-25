---
title: Session events — the feed of what happened
description: Why session state is published as transitions rather than polled as snapshots, who writes them, and what a consumer is expected to do
type: architecture
status: active
created: 2026-08-25
updated: 2026-08-25
---

# Session events

`ccmux list` answers **what is true now**. That is the wrong question for anything that wants to
react: a turn that starts and ends between two polls leaves no trace, and "this ran for thirty
minutes" cannot be recovered from two snapshots, because the start may have fallen between them.

The feed answers **what happened**. One append-only record per transition, in
`<stateDir>/events.jsonl`, rotated like the log, read through `ccmux events`.

## What the polling it replaces actually cost

Measured on a real consumer before this existed: a loop every 3 seconds, running `ccmux list --json`,
capped at 8 sessions, and seeing only the machine it ran on. Three costs, and the third is the one
that cannot be tuned away:

- the poll runs while nothing happens, and `list` is not free — it captures panes and computes launch
  stamps for every session;
- the interval is the resolution: a boundary is known "within the last N seconds", never *when*;
- a snapshot cannot express a transition at all, so duration and interruption are unrecoverable.

## Two writers, because one of them cannot see everything

**The turn hook** (`ccmux hook-status`) writes `turn-start`, `turn-end` and `session-start`. It runs
inside the agent's own lifecycle, so its boundaries are exact, and `turn-end` carries the duration
measured from the `working` stamp the previous hook left — nobody keeps a timer.

**The daemon's observation pass** writes what a hook structurally cannot, because the agent is not
running when these happen:

| event | why only observation can see it |
|---|---|
| `waiting` / `resumed` | the agent is stopped at a menu it cannot answer. Every other signal reads this as idle — still pane, no tool running — when it is the opposite |
| `turn-end` the hook never sent | `Stop` fires only when a turn ends *voluntarily*, and sometimes not even then; the turn would otherwise have a start and never an end, and a reader would show that session working forever |
| `session-stop`, `session-blocked` | nothing inside a dead session survives to report it |

`resumed` exists because the `waiting` pair is not otherwise closable: answering a permission prompt
puts the agent straight back to work **without a new user turn**, so nothing else would ever follow.
A reader tracking state would leave that session flagged "waiting for you" for hours.

`session-start` is deliberately NOT written by the daemon even though it can see a pane appear: the
hook says it better, a few seconds later but only when the conversation actually booted. Two writers
announcing the same thing differently is worse than one writer announcing it late.

## The `working` stamp must not outlive its turn

The lifecycle status file is where a turn's **start instant** lives, and it is the only place that
knows it. `Stop` is what closes it — and `Stop` fires only on a voluntary ending. So an interrupted
turn, or one whose hook simply did not run, leaves `working` behind with nothing inside the session
able to correct it. Measured on a live machine: seven sessions carried a `working` stamp, four of
them from turns that were already over, the oldest by two and a half days.

That stale stamp is not harmless bookkeeping. It costs three separate lies, and the third is the one
that hides:

- the abandoned turn never gets an end, so a consumer shows that session working forever;
- the **next** turn never gets a start, because a prompt arriving while the stamp says `working`
  joins the turn already running instead of beginning one;
- and that next turn inherits the old instant, so its duration — and `turnStartedAt` in the snapshot
  — measure from a turn that finished hours ago.

So the supervisor closes what the hook abandoned. Once the observation pass can prove a turn is over
(`turnState().settled`, the same standard chat delivery uses to decide it is safe to type into a
session), it writes `idle` with the event `ccmux:turn-closed`. Three consequences follow from that
one write, and each is deliberate:

**The duration runs to when the transcript stopped, not to when we noticed.** Proof of a dead turn
only arrives after a stretch of silence, so the instant we can say so is always later than the
ending — by the silence, plus however long until a pass looked. Measuring to `now` inflated every
such turn by at least a minute, and one nobody looked at for an hour by an hour.

**A turn already over on the first look is closed silently.** The daemon's memory is per-process; a
turn that ended while nothing was watching was not witnessed ending, and dating it to the instant a
daemon happened to start would publish a two-day-old event as news. The stamp is repaired either
way — silence about an event is never a reason to leave a false state behind.

**A turning spinner counts as activity, and one glance is not proof.** The evidence a turn is dead
is silence, and a session four minutes into a tool call is legitimately silent: it writes nothing to
the transcript, and the only thing still saying otherwise is its pane. Sample that pane in the
instant between a tool finishing and its result being written and there is no spinner either —
indistinguishable, on the transcript alone, from a turn nobody is coming back to. Measured: a live
turn closed and announced as interrupted 29 seconds after its own pane had been working, and a pane
seen working on one pass read still on the very next one, two seconds later. So the proof window
runs from the later of "transcript last moved" and "pane last seen working", and the first look at a
session acts on nothing — it has no baseline to be a diff against. Nothing is loosened for a turn
that really stopped: its pane stopped with it.

**A late `Stop` on an already-closed turn says nothing.** Both writers would be describing the same
ending, and the second one carries no duration. The hook recognises `ccmux:turn-closed` in the record
it is replacing and stays quiet.

The events switch decides what is *published*, not what is looked at: closing an abandoned turn
repairs this machine's own record of what its sessions are doing, which `list`, the TUI and every
snapshot read whether or not anybody subscribed to a feed.

## The snapshot answers "since when", the feed answers "what happened"

A consumer drawing live state wants a counter beside `working`: how long has this turn been running.
The feed alone cannot answer it — a transition is only heard by whoever was listening at the time,
and a consumer restarting is routine, not an emergency. After a restart it sees `working` and has no
way to tell three seconds from forty minutes, because the start is in the past and the next event
for that session will be the end.

So `list --json` and `fleet --json` carry `turnStartedAt` beside `state`. Two properties make it
usable:

- **It is an absolute instant, never an elapsed count.** Elapsed is only true at the moment it is
  produced: a snapshot that crossed a network and sat in a cache is short by exactly the delivery
  time, and drifts further the less often the consumer refreshes. An instant reads the same however
  late it is read — the consumer subtracts it from its own clock and ticks locally, with no polling
  and no subscription for the counter.
- **It is present only when there is a turn to be counting.** Null means either "not in a turn" or
  "in one whose start nobody recorded" — a provider without turn hooks, or a turn already running
  when ccmux started. `state` separates those: `working` with a null instant is "working, start
  unknown", which should draw as working *without* a counter rather than as a turn that just began.

`fleet --json` carries it for remote machines too, from their own `list --json`. A peer on an older
build simply omits the field and it reads as null — which is why `version` sits on the machine row
beside the sessions.

## Nothing runs on the event

The turn hook is **blocking** — it is what the agent waits on to finish a turn, and `stop-hook`
already owns its stdout channel. Running a consumer's command there would put somebody else's code on
the critical path of every turn on the machine, where one hung process stalls an agent. So the feed
is written, never dispatched: an append is one syscall, and reacting is the reader's job.

That is also why the file is not the contract. `ccmux events` is: a consumer parsing `events.jsonl`
itself would have to know about rotation, partially-written last lines, and where the state directory
lives on that machine — three things that are ours to change. The command also works the same locally
and through anything that can run a command on another machine, which is what lets one consumer watch
a whole fleet.

## At-least-once, and why `id` is load-bearing

`--since` takes a **time**, not a byte offset: an offset is meaningless the moment the feed rotates,
and rotation is normal here. Reconnecting therefore re-reads the boundary instant rather than risking
a gap, and two writers append without coordinating. So a consumer that *acts* on an event — speaks
it, blinks a light — must drop ids it has already handled. Exactly-once would need coordination the
hook cannot afford to wait for.

The record is parsed **leniently**: unknown keys ride through untouched. Strict parsing would turn "a
newer ccmux added a field" into "every event after the upgrade is unreadable on this machine" — a
fleet-wide silence produced by version skew nobody would think to check.

## Two output shapes, and why they are not one

`--json` prints the event. `--framed` wraps it: `{ data, cursor }`, where `data` is the event's JSON
with its newline and `cursor` is the event's own instant.

The second exists because a transport that carries a follow-style feed and can resume it needs a
per-line cursor of its own, in a fixed envelope it validates strictly — an extra key there is a
protocol error, not a courtesy. Verified before shipping: the plain `--json` line does not satisfy
that contract, so a stream profile written against `--json` would open and then fail on its first
line. Keeping the wrap opt-in means the common case — a person reading the feed, a consumer on the
same machine — does not pay for a contract it is not using.

The cursor is the event's timestamp, which is exactly what `--since` takes. So whatever a reader
hands back after a break, both sides are asking the same question in the same units.

**And the way it comes back is through the environment, not the arguments.** A feed with no natural
end is capped by a deadline, so a transport reopens it on a schedule — every fifteen minutes under
the profile this one runs behind — and hands the cursor to the producer as an environment variable,
because the node profile deliberately refuses caller-supplied arguments. `ccmux events` reads it, and
an explicit `--since` still wins: a person's deliberate question outranks a transport's mechanism.

Reading it is what makes the envelope's promise true. A producer that ignores that variable starts
from "now" and **nothing fails** — the stream opens, frames flow, and everything from the gap is
silently absent. There is no error to notice, only events that quietly do not exist for the consumer,
once every reopen. That shape is why the transport refuses to advertise resume (`stableCursor`) for a
producer that has not been shown to read the cursor: a resume that lies is worse than one that is not
offered.

## Two switches, defaulting on

`sessionEvents` in `machine.json`, and `eventsEnabled` per session — the same two-level shape as
chat, resolved in one place so a session can never be half-silent (emitting turn boundaries while its
waiting state stays hidden would show starts with no ends and read as a hung session).

The default is **on**, unlike chat: chat sends traffic to other agents and must be deliberate, while
an event is a line in this machine's own file that nobody has to read.

## A turn begins with a transition, not with a message

Both defects found on the feed's first day were the same shape, from different writers, and the rule
that removes them is one sentence: **deduplicate the transition, not the event.**

- The daemon re-announced an abandoned turn on every pass, because it deduplicated on a signal
  derived from "how long has the transcript been quiet" — which flickers within a single turn.
- The hook announced a new turn for every prompt, because a prompt that lands while a turn is
  already running joins it rather than starting one. A delivered chat message, a watcher's
  notification, a second question typed after the first: all normal, all previously a "turn-start"
  with no end.

The same write also moved the turn's **start instant** forward on each prompt, so `turn-end` reported
the time since the last message rather than the length of the work — a lie about the one number this
feed exists to publish, and a convincing one, since it is plausible on its face and only
under-reports more as a session gets busier.

Worth noting how both were found: not by the tests, which asserted a single transition and passed,
but by another consumer reading the live feed. A defect that lives in a *sequence* is invisible to a
check that looks at one event.

## Releasing a change to this feed: the consumer's machine goes first

Auto-update is phase-based — each daemon checks on its own schedule — so which machine lands a
release first is effectively random. That is fine for most changes and wrong for changes to this
feed, because the feed has an asymmetry the rest of the system does not: **the machine that consumes
it is one specific machine**, the one with the speaker and the panel. Twice in a row it happened to
be last, which meant the fix was live everywhere except where anyone could hear it.

So when the change is to the feed itself, pull it explicitly on the consumer's machine
(`ccmux update`) rather than waiting for its window. It bounces that daemon and nothing else;
sessions outlive it.

The same asymmetry applies when verifying afterwards. A window that reaches back before the bounce
still contains the old behaviour, and reading it as "the fix did not work" is an easy and convincing
mistake — made here once, within a minute of shipping. Take the daemon's start instant as the
boundary, and if nothing has happened since, say that instead of concluding something.

## Consumer notes learned the hard way

- **A closed reader is noticed on the next write, not when it leaves.** A closed pipe is only
  observable by writing into it — `destroyed`, `writable` and the `close` event all stay quiet.
  `ccmux events --follow` behaves like every other follow tool.
- **`console.log` swallows EPIPE.** The follower writes to stdout directly, which is what turns
  "reader went away" into a clean exit instead of a process that watches the feed forever.
- **A daemon bounce re-observes rather than replays.** The previous observation lives in that process
  only, so whatever is true after the bounce is emitted once, and nothing that happened while it was
  down is invented.
- **An empty feed is not evidence of anything.** A probe that asks "does this build read the resume
  cursor?" by looking for output confuses *the mechanism being absent* with *nothing having
  happened*: on a quiet machine both look identical. One such probe was handed to another team and
  nearly got a healthy, up-to-date node written off as stale, because its journal was simply empty.
  Test presence against something that does not depend on activity — the symbol in the shipped
  binary — and keep behavioural checks for machines you know are busy.
