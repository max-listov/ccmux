---
title: Native harness control roadmap with images first
description: Close concrete managed Codex and OpenCode control gaps without claiming complete harness or IDE parity.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
pipeline: native-harness-control
order: 0
depends-on: —
---

## Why

Native transport is not feature parity. The current managed control plane can supervise sessions,
send text, observe bounded events and resolve native requests, but it cannot yet carry an image
through the public message contract. Other gaps prevent a client from using native capabilities
without bypassing CCMux. This program prioritizes useful operations, not a promise to expose every
provider endpoint or reproduce an IDE.

## Evidence and reference baseline

Reviewed on 2026-08-30: CCMux `v0.39.24` and T3 Code main at
[`8dcb96314c976899e4df6951fb9af03131c2a46f`](https://github.com/pingdotgg/t3code/tree/8dcb96314c976899e4df6951fb9af03131c2a46f).
The comparison is source evidence, not a live parity test. References are pinned so later upstream
changes do not silently change acceptance.

| Area | Current CCMux evidence | Reference and intended result |
| --- | --- | --- |
| Images | `src/control/schema.ts` requires text-only `body`; native mailboxes also carry text | T3 attachment references and native image parts; deliver actual images to both runtimes |
| Live content | `src/agent/codex/ownedRpc.ts` opts out of text/output deltas; OpenCode accumulates a bounded text tail | T3 maps incremental content events; provide recoverable content updates, separate from cheap status |
| Selection | Typed model selection belongs to create; collaboration policy belongs to an immutable recipe | T3 send-turn options and in-session selection; change model/mode without replacing identity |
| Active input | Durable messages wait for idle; interrupt is separate | Explicit native steer without changing default queue semantics |
| Context | Public native reads are bounded projections, not conversation history or context management | Native history read, fork and compact; assess rollback separately because provider semantics differ |

Primary T3 sources: [adapter contract](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Services/ProviderAdapter.ts),
[turn input contract](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/packages/contracts/src/provider.ts),
[Codex adapter](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Layers/CodexAdapter.ts),
[OpenCode adapter](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/provider/Layers/OpenCodeAdapter.ts).
Native APIs: [Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[OpenCode server](https://opencode.ai/docs/server/). Fork/compact are native API opportunities;
this comparison does not claim that T3's common adapter exposes both.

## Result and order

1. **P1 — [Images](2026-08-30-managed-image-attachments.md).** Mandatory first usable slice:
   upload, immutable reference, native delivery, visual recognition and restart-safe retention.
2. **P1 — [Live content](../done/2026-08-30-native-content-stream-and-replay.md).** Incremental text,
   correlated lifecycle, reconnect and explicit truncation/gaps without amplifying status reads.
3. **P1 — [Model and mode selection](../done/2026-08-30-in-session-model-and-mode-selection.md).**
   Native per-turn options and persistent session defaults, independent of credentials/launch profile.
4. **P2 — [Explicit steer](../done/2026-08-30-explicit-native-turn-steering.md).** Deliberate active-turn
   input, never implicit steering by the existing message/defer path.
5. **P2 — [History and context](../done/2026-08-30-native-history-and-context-controls.md).** Bounded native
   history and deliberate fork/compact with exact continuation and safe mutation semantics.

`order` is the preferred integration order. `depends-on` in each task names actual prerequisites,
not permission to delay the image slice until every item is complete. Images, streaming and model
selection can be designed independently; their edits to control schemas, service descriptor,
capabilities and native admission must be integrated serially. Steering consumes the settled input
and selection contracts. Context operations consume attachment retention and stream reset semantics.
The five slices form one implementation package and one integrated release. Their priorities define
implementation order, not separate review ceremonies or separate releases.

## Boundaries

- Preserve one writer, exact managed/native identities, durable admission and fail-closed uncertainty.
  Do not add a second agent loop, transcript authority, general-purpose RPC passthrough or shell gateway.
- Extend the existing typed contract, service descriptor/client and native stream adapter. Reuse
  published transport primitives; a missing transport seam gets exact dependency evidence, not a
  consumer-side workaround. No new network endpoint is assumed by these task descriptions.
- Keep monitoring metadata distinct from authenticated conversation content. Tool payloads and
  internal diagnostics do not become public status fields. Never publish credentials or private fixtures.
- Capabilities describe each operation and its runtime/version/model constraints. `structured: true`
  and `nativeStream: true` must not imply images, full transcript fidelity or universal operation support.
- Existing Claude interactive behavior remains intact; unsupported new operations refuse before
  side effects. Custom integration stays in the existing
  [runtime task](../in-progress/2026-08-30-managed-native-and-custom-runtime-adapters.md) and does not
  block these Codex/OpenCode slices. No duplicate Custom task is created.
- Do not copy T3's framework, UI, auth infrastructure or lifecycle fallbacks wholesale. In particular,
  uncertain resume must not silently start another conversation. This scoped source review, not the
  older broad idea list in `docs/research/2026-07-30-t3code-analysis-ideas.md`, governs these tasks.
- Image input is not image generation. PDFs, arbitrary file types, skills/MCP administration, account
  management and official Desktop attachment are not implicitly included in this program.

## Plan

- [ ] Implement and verify the five linked slices in their declared scope.
- [x] Maintain an operation-level capability matrix with unsupported cases and version evidence in
  `docs/architecture/managed-runtime-drivers.md` and the published client documentation.
- [x] Keep architecture/ADR, packed clients and release notes aligned with each implemented slice.

## Global conveyor 2/2

One plan-validation pair and one implementation-validation pair cover the entire package, not
each child task separately. Validators are read-only; the implementation owner resolves findings.

- [x] Plan validator 1: typed contracts, native capability boundaries, state/identity consistency.
- [x] Plan validator 2: safety, recovery, testability, integrated E2E and release completeness.
- [x] Incorporate both plan reviews and begin the refined package implementation.
- [x] Run complete local gates, packed consumer checks and real integrated native E2E.
- [x] Implementation validator 1: audit all package code for protocol/state/contract correctness.
- [x] Implementation validator 2: audit all package code and evidence for safety and regressions.
- [x] Resolve both implementation reviews and rerun affected plus complete gates.
- [x] Publish one integrated release and verify exact artifact parity on all owned runtimes.

Current phase: the native package and its corrective privacy patch are published and verified on
all owned runtimes. Both independent implementation reviews and installed-artifact E2E are PASS.
The authorized follow-up release carries the unversioned control surface and Biome gate recorded
in `../done/2026-08-30-unversioned-control-and-biome-gate.md`. Release verification uses an isolated
daemon/configuration without notification destinations for mutating native probes; production
checks read the installed contract and session continuity without sending fixture messages.
Installed-artifact verification also exposed an initial content/readiness race, tracked in
[`2026-08-30-native-content-before-readiness.md`](../done/2026-08-30-native-content-before-readiness.md).
Corrective `v0.39.28` passed downloaded-artifact acceptance, exact native requests, two-runtime chat,
restart/resume and three-runtime parity with 33 running sessions preserved. The task records exact
hashes and the retained failed-probe evidence; late approvals remain serviced through terminal pickup.
Cross-machine image acceptance is held only by the transport activation boundary below.
The existing native runtime integration task retains its
separate optional published-dependency boundary; these five tasks do not claim that dependency ready.

### Accepted global review decisions

- Use one current control contract, descriptor, client path and native-content stream. Breaking
  changes are authorized; there is no installed-client compatibility requirement. Replace obsolete
  endpoints, aliases, wrappers and version-parallel implementations in the same package. Update
  owned callers and packed tests to the current contract; do not preserve an old-client test lane.
  Durable session identity, history and accepted-operation safety remain mandatory.
- Separate immutable create selection, revisioned defaults and accepted per-turn effective options.
  Recipe mode is a startup default; selection does not grant sandbox, approval or credential authority.
  Serialize native mutations with daemon pickup, not merely between service calls.
- Attachments are authorized by principal, exact registration and execution host. Validate full image
  decoding, not just signatures. Retain accepted assets across archive/fork and bound unfinished uploads.
- Content uses the existing owner observer with its own bounded buffer and notifications, not the
  coalesced monitoring wakeups. Protect terminal/request events from token floods; expose omissions.
- Fork reserves the destination owner first. Dispatch intent precedes provider mutation; a lost
  uncorrelated fork response stays uncertain and is never retried as another native fork.
- Inspect installed OpenCode v2 native operations before choosing classic APIs. Exact steer requires
  a native expected-turn guard; unsupported is explicit where that guarantee cannot be proven.
- Test near-limit image history during reconnect/restart without raising all native response bounds.
  Remote image acceptance must cross machines through the declared service transport, not a local
  ingress closure described as remote.
- The newly arrived application-policy task joins this same package and review pair. Its policy
  provenance, immutable admission and safe applied evidence must not duplicate launch configuration.

Baseline: `bun --no-env-file run check` passed: 831 tests, 3937 assertions; packed Bun/Node and both
TypeScript resolution modes passed. This is baseline evidence only, not new-feature acceptance.

## Acceptance

- [x] Both native runtimes receive real image input through the published control service; image-only
  and text-plus-image turns pass without a local-path or terminal workaround.
- [x] Content, selection, steering and context acceptance are resolved individually in their tasks;
  an unavailable placeholder or a passed transport test is not reported as complete functionality.
- [x] Integrated E2E combines image delivery, streamed response, a model/mode change, exact native
  requests, interruption and restart/resume while preserving one writer and durable accepted work.
- [x] Each shipped slice records local gates, packed Bun/Node consumer checks, exact-SHA CI,
  release/tag and artifact hashes, plus owned-runtime rollout parity. Do not invent a future version.

The image task's real cross-machine transport acceptance remains unverified and keeps this roadmap
open. Local service probes are not substituted for that external acceptance.

## Что сделано

- One current service revision `current`, native profile `ccmux-native` and operation-level capabilities
  replace the old control shapes/routes. No legacy endpoint, alias or parallel compatibility client
  is retained. Durable managed identities, native history and accepted-operation semantics remain.
- The package includes image input/preview, bounded native streaming/replay, persistent and per-turn
  selection, exact Codex steering, native history/fork/compact, and immutable application-policy
  evidence. The six implementation tasks record their actual native checks and source paths.
- The two global implementation validators found and verified fixes for policy-agent admission,
  missing native Plan content, late updates to truncated terminal items, failed-subscriber watcher
  cleanup, lease-only metadata frames and context reads blocking heartbeat/approval. Both then
  returned PASS, including the final image-order and cancellation-pump changes.
- Current image/steering program exited 0 on both native runtimes. Ordered PNG/JPEG pairs passed
  in both directions, with same-ID retry and reversed-order conflict refusal. Evidence SHA-256:
  `72ecc84bc713bbe2bcad6f52e1c3252c1a642f2bbae12e92e92dc619a8b6f9ea`.
- Publication and owned-runtime parity passed against the downloaded artifacts; details follow below.
- Final pre-publication `bun run check` exited 0: 926 tests, 4,536 assertions across 146 files;
  packed installation, Bun/Node runtime, TypeScript NodeNext and bundler-resolution consumers passed.
  The targeted private-catalog-diagnostic regression also passed; exact causes are retained only in
  a private directory/file and public errors stay generic. `git diff HEAD --check` is clean.

## Transport activation boundary

The 2026-08-31 preflight supersedes the earlier old-descriptor finding: the remote binding now
declares the current 26-operation service and native profile. It reaches the production daemon
with user-facing notification mirroring enabled. Real mutating fixtures must remain isolated;
silencing the production mirror or emitting test notifications is not an acceptance substitute.
The image task records this narrower outstanding isolated-binding boundary. Production read
checks and independent Custom integration continue; no alternate gateway is introduced.

## Post-publication native acceptance finding

The installed `v0.39.25` bundle and downloaded client passed real Codex image/history/fork/compact
acceptance, but the OpenCode history probe found native `synthetic: true` read-tool text containing
an internal attachment-store path. A native compaction summary can repeat the same internal data.
These are runtime-generated context, not user-authored conversation text. The owner fix excludes
synthetic and compaction-summary text by native metadata across history/content projection, retains
explicit history omission counts, and never heuristically rewrites ordinary user/assistant text.
The corrective installed-artifact check passed on both real runtimes. An initial post-patch fixture
rejected a semantically correct image description because its wording matcher was too narrow;
the equivalent shape/color wording was accepted in the corrected fixture, without weakening identity,
privacy or compaction requirements. Failed evidence is retained separately from the passing run.

The corrective source passed the complete local gate: 929 tests, 4,556 assertions across 147 files,
plus packed installation, Bun/Node and both TypeScript resolution modes. Both independent global
implementation validators returned PASS after re-reviewing the metadata-based fix; focused reviews
also confirmed terminal outcomes and native selection are retained. Selection, explicit steering
and applied-policy tasks are closed against their actual published `v0.39.25` evidence. Content
and context tasks are closed against the corrective installed-artifact check. Images and
this roadmap remain open only for the external transport activation.

## Published acceptance

The public [post-rollout verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.26/post-rollout-verification.json)
records the exact release, bundle/client integrity, live acceptance and remaining boundaries.
Its SHA-256 is `6a5a9a1af7d31e6184736d61b41ce62a8b91a1391361f13edccea8c4c16882e6`.

- [x] Corrective release `v0.39.26`, release/tag `24cdb31e2997e4deea9e0e36ee992bc1da71d782`;
  native-package implementation `3c7235454e657cefa5ec570d6fb4c927293b07e4` and metadata privacy fix
  `5b1692f9e3e5ceb7879a0bf99f801316072cab56`. Complete gate: 929 tests, 4,556 assertions;
  both independent implementation re-reviews passed. Exact-SHA CI
  [33296143751](https://github.com/max-listov/ccmux/actions/runs/33296143751) passed.
- [x] Downloaded runtime SHA-256: `6d2685bc49c517ba4abd812f5ed16714d763189328aa8c84fa8356a96c49ed42`;
  downloaded client archive SHA-256: `15475d4f55670be57f803802c78a7d009f0280f0dcdbb88f686ef71100f6b3d8`.
  Actual published bytes passed packed installation, Bun/Node and both TypeScript resolution checks.
  All three owned installations match the runtime version/hash and report live owner projections.
  The 33 pre-existing running sessions retained identity and remained running.
- [x] Repeated installed-bundle/public-client acceptance passed on real Codex and OpenCode: actual
  image recognition, exact preview, native content/history, idempotent create/message/fork, distinct
  fork identity, source preservation, retained image access, native compaction with one revision/reset,
  and retained unfinished checkpoint plus prior image facts. Internal attachment paths are absent
  from public history/content. Evidence SHA-256:
  `17edd555128d5e156b5e1397246ef193fee29258e7c84a716e7b7cdce3f68d9a`.
  Cleanup archived/stopped all four fixture sessions and preserved unrelated registrations/daemon.
- [x] `scripts/opencode-runtime-e2e.ts` passed again against the installed bundle: real tool effect,
  exact input/approval, busy/defer, interruption, two-runtime chat/reply identity, daemon/provider
  restart and continuation, then archive. Evidence SHA-256:
  `429f099cd94a0f8035755acdf50f05dcba8bfabb6c073192341c07299bbfa30d`.
