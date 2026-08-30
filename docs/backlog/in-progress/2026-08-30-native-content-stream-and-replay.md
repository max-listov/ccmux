---
title: Recoverable native content streaming beyond status snapshots
description: Expose incremental conversation content with bounded delivery, exact cursors and honest replay limits while retaining cheap monitoring.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
pipeline: native-harness-control
order: 2
depends-on: —
---

## Why

`src/agent/codex/ownedRpc.ts` explicitly opts out of agent text, reasoning summary and command-output
deltas. `src/agent/opencode/projection.ts` consumes native text deltas but keeps a bounded text tail.
`ControlNativeSnapshotSchema` and `src/agent/codex/ownedSchema.ts` describe a bounded projection,
not a lossless transcript stream. A client cannot infer completeness from `nativeStream: true`.

T3's [Codex adapter](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Layers/CodexAdapter.ts)
maps native content deltas independently from item and turn lifecycle. Its
[OpenCode adapter](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Layers/OpenCodeAdapter.ts)
also correlates incremental content with native message/part identities. Reuse those principles;
do not replace prepared fleet monitoring with full transcript scans.

## Result and state

An authenticated conversation-content subscription exposes incremental assistant text, available
provider-supplied reasoning summaries, tool lifecycle/progress, usage and terminal outcomes.
It identifies runtime, managed registration, native session, turn and item plus generation/sequence.
Reasoning summaries are only what the provider exposes; no hidden chain-of-thought is promised.

State: `baseline → live → gap/resync` or `disconnected/unavailable`. Deltas use stable item offsets
or revisions; a complete-item replacement is distinguishable from an append. Reconnect inside the
retained window replays safely; outside it returns an explicit gap and bounded authoritative reset.
Truncation, omitted bytes and unavailable older content are data, never silent clipping. Final
native completion, not stream closure or a quiet interval, decides the turn outcome.

## Plan

- [x] Specify one current native-content envelope and per-operation capabilities distinct from cheap
  status. Replace the superseded native-content interface; do not retain legacy streams, aliases or
  parallel clients. A revision identifies the current contract, not a compatibility branch.
- [x] Extend existing native observers and typed service stream adapter; no second native writer,
  per-reader provider connection, CLI process, transcript poller or separate transport stack.
- [x] Use one bounded shared observation/replay buffer with explicit retention, frame bytes,
  subscribers, queued bytes, cancellation and backpressure. Slow consumers cannot stall the writer.
  Reuse the current generation/cursor boundary rather than introducing a second transcript authority.
- [x] Deliver text deltas and complete-item reconciliation without duplicated text on reconnect,
  repeated native events or completed-item replacement. Preserve UTF-8 boundaries and causal order.
- [x] Keep sensitive content separate from status metadata. Define any command-output/diff access
  as an explicit authenticated content capability; do not enable a raw provider event/diagnostic dump.
  Internal errors and credentials stay private; user conversation content is not heuristically rewritten.
- [x] Update stream descriptor/client, architecture and a reconnecting consumer example. Older history
  beyond retention belongs to the separate native history task, not an unbounded hot replay log.

## Acceptance

- [x] Both real native runtimes deliver multiple content updates before the terminal event for a
  sufficiently long answer. Reassembled text matches native final content within advertised limits.
- [x] A response larger than the current 8,192-character tail is either retrieved completely via
  bounded parts or has explicit truncation/recovery metadata; it is never labelled complete falsely.
- [x] Duplicate/out-of-order events, UTF-8 splits, reconnect within/outside retention and a generation
  change yield no duplicated text, missing terminal outcome or cross-session content.
- [x] Native approval/input still appears promptly during heavy content output and receives exactly
  one correlated answer. Interrupt/failure/disconnect remain distinguishable.
- [x] Slow subscribers and cancellations have bounded resource use. Record latency, bytes and CPU
  with one and multiple readers over a sustained run; monitoring does not launch extra native scans.
- [ ] Golden native-event tests and real E2E cover both runtimes. Packed Bun/Node consumers,
  complete local gates and exact-SHA CI pass; publish and verify the exact artifact on owned runtimes.

## Boundaries

No UI, new inference loop, unlimited event journal, official Desktop bridge or opaque raw-event
passthrough. Part of the [native control roadmap](2026-08-30-native-harness-control-parity.md);
the tasks share one integrated release and one global validation pair.

## Что сделано

- `src/content/` implements the single bounded replay/baseline authority; native observers feed it
  without new provider connections. `src/control/nativeFeed.ts` and the current descriptor/client
  expose the same authenticated frames. Limits and reconnect rules are in
  `docs/architecture/native-content-and-turn-controls.md`; `scripts/native-content-acceptance.ts`
  is the runnable one/eight-reader consumer.
- Actual Codex responses were 15,511 bytes and OpenCode responses 15,731 bytes: each assembled text
  exactly matched native final history with one and eight subscribers. One slow reader consumed at
  250 ms/frame without blocking the writer. Fast-reader mean latency was approximately 57–67 ms;
  maximum 133 ms. Codex observer CPU was 4.58/6.60 seconds, OpenCode 1.40/1.39 seconds for the one/
  eight-reader runs. Slow-reader delay remained explicit and finite, not a provider-side stall.
- Text digests: Codex `7e36b75fcfa7c9c53740c91a4e894ed95f93266ffdb5aabd7d6e70675b836cf9`,
  OpenCode `1d44e5edb880d1cbc1aee2d0e6e56dec628b2be57169dd661700633898b36698`.
  Each fixture archived its managed session and verified its three tracked processes stopped.
- Golden and regression tests cover UTF-8 offsets, duplicate/out-of-order events, bounded resets,
  retained terminal/request priority, truncated completed items, native Plan events, watcher cleanup,
  and idle lease/settings frames with an unchanged content cursor. Native approval/input, interrupt,
  model change and restart are exercised by the integrated selection/image/context programs.
- Both independent implementation validators passed the entire package and their final targeted
  rechecks. Exact-SHA CI, published artifact and rollout evidence remain in the global release gate.
