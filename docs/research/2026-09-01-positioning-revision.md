---
title: Positioning revision — what this supervisor is for in late 2026
description: A five-player landscape refresh (the external reference harness, Happy, Omnara, Conductor, first-party Anthropic surfaces) reconciled with what consumers actually use ccmux for today.
type: research
status: active
created: 2026-09-01
updated: 2026-09-01
---

# Positioning revision, 2026-09-01

Two read-only researchers refreshed the external landscape against primary sources (GitHub API,
npm registry, code.claude.com docs, vendor sites); consumption was surveyed in the actual consumer
code, not recalled. Prior research this builds on rather than repeats:
[the external reference harness analysis](2026-07-30-the external reference harness-analysis-ideas.md),
[Happy and CodexMonitor](2026-08-28-happy-and-codexmonitor.md), [ACP](2026-06-10-acp.md).

## The watershed nobody planned: subscription legality

Anthropic's policy (clarified 2026-02-19, [legal](https://code.claude.com/docs/en/legal-and-compliance),
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)) forbids third-party
products — Agent-SDK-based ones included — from riding claude.ai subscription credentials.
Enforcement is real: OpenCode dropped Claude support after legal requests (The Register,
2026-02-20), and one widely used third-party harness carries unresolved mass-401 reports against a
valid Max OAuth login on its SDK path. The one fully sanctioned way to run a Max subscription is
unmodified Claude Code itself.

That is precisely what this project does: interactive CLI in tmux, supervised rather than wrapped.
The pane-scraping this costs is not a legacy embarrassment — it is the price of the only durable
subscription path, and every competitor that avoided it either pays per token, sits in a gray zone
that has already broken, or lost Claude entirely.

## The five, in one paragraph each

**A GUI-first multi-agent harness** (~21k stars, stable release of 2026-08-31, nightly cadence): a
real product — local server, web, Electron, native iOS/Android through its own relay. Talks
protocols, not panes (codex app-server, Agent SDK, ACP); persistence is a sequenced SQLite log with
reap-and-resume. Single machine plus relay; no fleet, no self-heal. Its Claude path reads the
user's subscription through the SDK — the gray zone above.

**Happy** (slopus): pivoted off this field. The classic path — mobile client over stock Claude
Code via jsonl-tail and an E2E relay — is frozen (happy@1.2.2 stays last; self-host server two
months stale; even the mobile app's final commits point at the new stack). The live path is
happy-agent v0.4.27, an own harness built on Pi ("the best of Pi, Codex, Claude Code — unified"),
plus happy2 ("What would Slack be if agents came first"). Happy now competes on harness choice,
not on supervising native sessions.

**Omnara** (YC S25, Apache-2.0, releases through 2026-08-29): topologically the closest — a daemon
per machine, pty-driven processes, Postgres state, multi-machine — but cloud-relay-first: the
phone reaches your machine through their WebSocket relay, and the product is pivoting toward a
hosted agents API.

**Conductor** (closed-source Mac app): parallel Claude Code/Codex in git worktrees with polished
diff review; BYO subscription and legal about it, because it drives the real CLI. One Mac plus
their managed cloud machines.

**Vibe Kanban** (BloopAI): the cautionary tale. 28k stars, then the company closed 2026-04-10, the
server side went off, and the product is effectively dead — sessions and workflow died with the
vendor. (claude-squad remains a live but local tmux+worktrees TUI; no daemon, no fleet.)

## First-party Anthropic is the neighbour that matters

Verified against code.claude.com docs, not marketing:

- **Remote Control**: phone/web as a window into a locally running CLI session — live transcript,
  permission prompts, diff, push notifications. Subscription plans only; outbound HTTPS; the
  transcript is stored on Anthropic's servers (explicitly not E2E; ZDR orgs excluded). Their own
  resilience advice for the local process: "start it inside tmux".
- **Cross-session messaging**: default-on since v2.1.224 — ListAgents/SendMessage between one's
  own sessions, across machines, via Anthropic's servers. A direct overlap with this project's
  identity-pinned chat, with different trade-offs: Claude-only, vendor-relayed, no fleet registry.
- **Agent view**: observing and steering many local sessions from one place.

Conclusion the research forces: "watch and drive your Claude session from a phone" is now solved
better first-party than it can be rebuilt at home. What first-party does not do: a fleet as an
object (machines, health, healing, reboot-resume, auto-update), non-Claude runtimes, transport
that avoids the vendor's servers, or chat between heterogeneous agents.

## What this project actually is, by observed consumption

Surveyed in the consumer code of a private application that builds on ccmux, and in this fleet's
own operation:

1. **The sanctioned Claude subscription fabric.** Interactive Claude Code sessions in tmux across
   machines, healed, reboot-resumed, auto-updated — the only path that burns a Max subscription
   with the vendor's blessing.
2. **A control plane for native runtimes.** The consumer drives Codex, OpenCode and the Custom
   harness through the typed client — create, message, watch, history, approvals, interrupt,
   attachments, model catalogs — and renders live conversations with tool approvals and token
   metrics in its own frontend. This exists and works today.
3. **The fleet as an object.** Machine registry and map, per-machine daemon, self-heal,
   reboot-resume, release standing, doctor, bounded monitoring snapshots. None of the five offers
   this; Vibe Kanban demonstrates what its absence costs when a vendor disappears.
4. **Inter-agent mail.** Identity-pinned addressed chat between agents on different machines, with
   delivery safety around live composers, holds with named reasons, and no third-party server.
   First-party cross-session messaging validates the need while taking the opposite trade
   (Claude-only, vendor-relayed).

Who it is for: an operator who owns several machines and a subscription, runs a heterogeneous set
of agents on them, wants them to survive reboots and vendor outages, wants his own frontend over
native runtimes, and does not want transcripts held by a third party.

## The honest gaps

- **Live Claude transcript in one's own frontend.** The consumer has live Codex/OpenCode/custom
  conversations through the control plane; Claude's conversation lives in jsonl and is not served
  as structured content. This is the gap the owner actually feels. The proven recipe is the frozen
  Happy classic path: tail the session jsonl, deduplicate by UUID/message id — combined with the
  feed contract this project already ships for chat (position cursor, bounded frames, resumable
  stream). No terminal emulator, no tmux control mode (rejected on evidence 2026-09-01, see the
  planned task), no SDK.
- **Typed events and structured approvals for Claude.** The interactive CLI exposes no protocol;
  hooks and jsonl carry part of it. The gap versus the reference harness persists by construction and is the accepted
  cost of the legality watershed. Codex/OpenCode/custom already have the typed path here.
- **Client polish.** Native mobile apps (the reference harness), first-party Remote Control UX. Not a race worth
  entering; integrate instead — a supervised session can carry `--remote-control` for the
  first-party window while remaining fleet-owned.
- **Reap-and-resume economics.** the reference harness/Omnara resume on demand instead of keeping processes alive.
  For subscription-based interactive sessions the always-alive model is the point, not the waste;
  the cost that does exist (observation cycles) is measured at ~13% of one core per machine.

## What this does NOT conclude

No product pivot, no rename, no client rebuild. The niche claimed by VISION ("persistent
multi-machine self-healing fleet") narrowed but held: Omnara approaches it cloud-first,
first-party surrounds it Claude-only. The unoccupied intersection is exactly where this project
already stands: sanctioned-subscription Claude + native-runtime control plane + owner-controlled
fleet + inter-agent mail, with no vendor in the transcript path.

Watch list: happy2 (an agent "Slack" may collide with inter-agent chat), Claude Code agent
view/channels (weekly feature cadence), Omnara's daemon topology.
