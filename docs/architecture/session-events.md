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
| `turn-end` with `interrupted` | `Stop` fires only when a turn ends *voluntarily*; an escaped turn would otherwise have a start and never an end, and a reader would show it working forever |
| `session-stop`, `session-blocked` | nothing inside a dead session survives to report it |

`resumed` exists because the `waiting` pair is not otherwise closable: answering a permission prompt
puts the agent straight back to work **without a new user turn**, so nothing else would ever follow.
A reader tracking state would leave that session flagged "waiting for you" for hours.

`session-start` is deliberately NOT written by the daemon even though it can see a pane appear: the
hook says it better, a few seconds later but only when the conversation actually booted. Two writers
announcing the same thing differently is worse than one writer announcing it late.

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
