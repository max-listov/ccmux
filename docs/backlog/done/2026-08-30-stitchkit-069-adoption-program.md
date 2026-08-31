---
title: Adopt the published Stitchkit harness as the custom execution engine and bounded evidence foundation
description: Integrate the published headless harness through the existing supervisor, with exact continuation, host-owned tools and policy, bounded observation and release-grade acceptance.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31T05:34:02+07:00
priority: P1
related: 2026-08-30-managed-native-and-custom-runtime-adapters.md
---

## Purpose and authority

CCMux supervises persistent agent sessions; Stitchkit supplies execution primitives. The useful
outcome is a real fourth runtime under the existing control plane, not another framework inside
the daemon. Native Codex, OpenCode and interactive Claude keep their own execution engines.

The authorized program covers implementation, verification, publication and owned-runtime rollout.
Acceptance remains open until each required behavior has inspectable evidence. Optional subsequent
work and consumer deployments stay outside this execution scope.

The existing [runtime adapter task](2026-08-30-managed-native-and-custom-runtime-adapters.md)
remains the canonical task for the Custom runner. This plan supplies its dependency cutover,
integration sequence, cross-cutting diagnostics and combined acceptance; it is not a duplicate runner task.

## Verified baseline

- CCMux `0.39.33`, source `a6e683ed5a900627439eb97e1a8a63c7680f5bee`, pins `stitchkit@0.68.5`.
- Registry `latest` is `stitchkit@0.70.1`, verified on 2026-08-30.
- [Release source](https://github.com/max-listov/stitchkit/tree/c9a86d4962178debc017a821d7034aed18bd91da)
  resolves tag `v0.70.1` to `c9a86d4962178debc017a821d7034aed18bd91da`.
- The real registry archive was downloaded, not rebuilt from the dependency checkout. SHA-256:
  `6d1bacd4d84f0da5cb1317e39f9f96cffb65f3582002ab72982f97bb96b54ea0`, 753080 bytes.
  Its SHA-512 matches registry integrity:
  `sha512-UySE/DO1p7XZDmbISX3+U9RCYpepqsElovnL4IgUu0C9BpsFXGbYpoF0nL38vpY8SLV2frLiZXyy05gmmyrhrg==`.
- The archive contains JS and type targets for `agent-runtime/harness`, `coding-tools`,
  `sqlite/bun`, `browser`, `openrouter` and `application`. This proves publication, not live adoption.
- The published CCMux baseline reports Custom unavailable in `src/runtime/catalog.ts`; create explicitly refuses
  Custom in `src/control/lifecycle.ts`, and `src/runtime/driver.ts` has no Custom implementation.
- The published Agent unions include the `tool` role and approval request/response parts. Coding
  operations use `read_file`, `write_file`, `search_files`, `apply_patch`, `run_command`,
  `read_output` and `read_resource`; do not introduce obsolete prefixed names or an unguarded edit alias.
- The optional terminal package is `stitchkit-tui`; its bootstrap publication has separate owner
  acceptance and does not block headless integration. No obsolete scoped alias is adopted here.
- Published-package probes and managed real-model acceptance qualify the behavior stated below;
  the former sequential-approval blocker is resolved in the current qualification below.

## Execution status

### Published dependency follow-up

At `2026-08-31T04:57:26+0700`, registry `stitchkit@0.70.2` and tag `v0.70.2` are
published. The tag resolves to `9df049633804ffab5daffffa2de16a40373ebdfc`; registry
integrity is `sha512-5S2VhE81Qv3gmaYp21udzsxa70HviIfYKAPRnB5Zba546z9mcuysrvoXjnAJmkGSx19aJXaEw9EoD/e/RsE2Dw==`.
The same authorized release resumes in the canonical checkout: adopt the published package,
repeat both sequential-approval probes, then complete real acceptance and the full gate.
The following `0.70.1` results are retained as historical reproduction, not the current
dependency publication status. No acceptance is closed merely because the new tag exists.

The downloaded `0.70.2` archive SHA-256 is
`7c8e27283de010d408fd5e8d8ebd0e1517ed4762a58037ca5f029f1de702ebed`; SHA-512 matches
registry integrity. Both previously failing sequential-approval probes now pass: both file effects,
three model calls, terminal `success`, no diagnostic failure. The adapter regression has nine assertions.
Real installed-candidate service acceptance also passes create/message retry, signed allow after
worker restart, stale/changed answer refusal, daemon restart and exact continuation; followed by
read/search/guarded patch, exit 0/7, signed denial, defer and active interrupt with child cleanup.
Evidence SHA-256: `68e4f68b7f3ef97baa578aa77dabd4b8e707bb09c61c08424ee688133de2ef38`.

The coding probe now waits for the prepared monitoring view to observe the exact native turn,
rather than assuming `native.read` and periodic `session.get` publish atomically. The retained
first attempt fails at that assertion; the corrected probe records the initial observation and
requires the exact waiting/working transition before continuing. No runtime delay or fallback
was added. Initial full gate after dependency adoption: 984 tests, 4,992 assertions, all five
packed consumers passed. The external-content task joins the release convergence scan; a final
combined gate and actual publication/rollout remain required.

Final combined pre-publication gate on 2026-08-31 passed Biome, TypeScript, 993 tests / 5,069
assertions across 167 files and all five packed-client consumers. Gate log SHA-256:
`9b4c4202dfd72f2d40679f019c6e7a7c1447b88ca8fbb6fce7882ced5f2a4e3d`.
Candidate bundle SHA-256: `10eebf641e6327611920a6cd2e0c0d0c1221c806282fcd1edb6094bd1fc994c0`.
Actual publication and installed-artifact acceptance remain open until performed.

### Prior package qualification

Published `stitchkit@0.70.1` resolves the reproduced macOS file backend blocker. Real public
file operations pass on macOS and Linux, under both Bun and Node. The required security probes
remain enabled. Raw `/dev/fd` access is diagnostic only: the Darwin backend now uses packaged
native `openat` handles, not descriptor path emulation.

At that prior qualification the tree pinned `stitchkit@0.70.1`, `ai@7.0.85` and the optional model adapter
`@openrouter/ai-sdk-provider@3.0.0`. The pre-integration baseline gate passed 962 tests across
155 files with 4,812 assertions. Current acceptance includes a deliberately enabled sequential
approval regression that fails in the published dependency. A historical baseline is not a current
green gate or authorization to publish the partially qualified adapter.

The Custom driver, public create/control/correlation, canonical history/images, native profile,
installed runner packaging and daemon/worker diagnostic lifetimes are implemented. Real managed
single-approval, restart and three-runtime acceptance pass; detailed evidence is recorded below.
The remaining release blocker is not file containment or provider credentials.

The current local packed control-client archive passes install, Bun, Node, NodeNext and bundler
checks; SHA-256 `10698a05245c51130362951b09a9025002e6729ddff8c06972c6e311eb4d74b9`, 58,621 bytes.
This is a local qualification artifact, not a published release.

Published-package qualification uses `scripts/custom-tool-boundary-acceptance.ts` and
`scripts/custom-file-platform-acceptance.ts`. `scripts/custom-tool-observation.ts` observes the
actual Promise success/rejection channel; error-shaped successful business data is never inferred
to be a failed tool. Its classification has explicit regression tests.

| Probe | Linux | macOS |
| --- | --- | --- |
| Normal root/nested read, write, patch, search, file resources | Bun and Node pass | Bun and Node pass |
| Ordinary direct filesystem read | passes | passes |
| Parent-swap read and patch | refuse with no outside effect | refuse with no outside effect |
| Stale patch digest | typed rejected CONFLICT | typed rejected CONFLICT |
| Finite commands and cancellation | exit 0/7 preserved; no running child or late effect | same guarantees |
| Signed approval, SQLite reopen, separate successor, deny, no terminal replay | seven Harness probes pass | seven Harness probes pass |

The cancellation probe distinguishes an exited Linux zombie from an executing child. A positive
pre-cancel state and absence of a delayed effect are both required. Merely testing PID existence
can falsely report a cancelled child as running before its parent reaps it.

`scripts/custom-harness-acceptance.ts` uses a deterministic model and real published Harness,
SQLite and coding tools. Its seven single-continuation probes prove only their exact cases.
`scripts/custom-sequential-approval-probe.ts` independently exposes the missing multi-continuation
case using only published dependencies, without any CCMux adapter or provider network.

Evidence log SHA-256 values:

- macOS Bun platform: `c476d218edc8aa148a4f7ee3202809f98eb809ff90c59077055decf3f59b7fca`.
- macOS Node platform: `a0471fb131f17df801d066cfdf627aa31b3f83cb33dbe143a8f16f7c0d1bd208`.
- macOS cancellation/boundary: `3b33ac0c27eebd82197399285e2a516d445d27130a0f8672d0895c3dcff75c08`.
- macOS Harness/SQLite: `8cb2b14b8d4db473505c769398de3fda12ef8e449dcc113c37af24140dab5e6b`.

`mountAgent` in `stitchkit/tools` requires the documented MCP peers even for this use. The isolated
qualification consumer installs those peers; no MCP service, renderer or alternate execution loop
is installed in CCMux. To repeat, install the same published Stitchkit version with its documented
tool-mount peers in an isolated consumer and pass its `node_modules/stitchkit/dist/tools.js` path
to `bun --no-env-file scripts/custom-tool-boundary-acceptance.ts`. The script verifies package
versions match and exits nonzero when any required boundary fails. For the platform probe, pass the
installed Stitchkit package directory to `scripts/custom-file-platform-acceptance.ts`; the same
module runs under Bun and Node. All effects use disposable fixtures, not live registrations.

No production machine recipe is activated and existing supervised sessions are unchanged. This
authorized program continues after the upstream history fix through the remaining real managed
acceptance, publication and rollout; partial gates are not completion.

## Historical dependency blocker (resolved by published 0.70.2)

Stitchkit `0.70.1` fails on two ordinary sequential signed user approvals. The first tool effect
succeeds; its successor contains that tool-result followed by a new call/approval. On accepting
the second request, `completeToolChronology` rejects the successor's leading result because its
call belongs to a previous canonical record. The whole assistant, including the new request, is
omitted. AI SDK then reports `AI_InvalidToolApprovalError` and the next run commits
`provider_failure` before invoking the model. This does not require automatic approval.

The isolated published-only probe on macOS and Linux and `test/custom-multiple-approvals.test.ts` reproduce two model
calls, first effect present, second effect absent, terminal failure. A real model coding turn also
fails after an approved patch asks for an approved command. Exact native cause is retained by
`createAgentObservability` in the private diagnostic sink. No signature or chronology check is
disabled, and no provider-history workaround is installed here.

The existing dependency task `stitchkit/docs/backlog/in-progress/2026-08-30-automatic-approval-history-chronology.md`
contains the cross-record user-approval reproduction and source fix. Its current evidence reports
249 passing focused tests and packed Bun/Node approval checks, but corrected package publication
remains unchecked. The retained review artifact is not the registry artifact and is not adopted
as a runtime dependency here. Its implementation, commit and publication remain with the dependency
owner; no duplicate task or consumer chronology workaround is needed.

### Release preflight qualification

Verified at `2026-08-30T23:34:46+0700`: registry latest and the latest GitHub release remain
`stitchkit@0.70.1` / `v0.70.1`, with the registry integrity recorded above. The explicit CCMux
release mandate is active; the missing corrected dependency artifact, not release authorization,
prevents publication from this checkout.

- `bun --no-env-file test test/custom-multiple-approvals.test.ts`: exit 1, zero passing and one
  failing test, five assertions; `AI_InvalidToolApprovalError` on the second signed continuation.
- `bun --no-env-file scripts/custom-sequential-approval-probe.ts`: exit 1 without importing CCMux
  implementation; first effect present, second absent, two model calls, terminal `provider_failure`.
- Dependency source qualification is reported by its task; it is not a corrected published package
  or a fresh complete CCMux gate. No full gate, release bump, commit, tag or rollout is claimed for
  this preflight. Existing staged implementation and supervised sessions remain unchanged.

Resume the authorized release from the same working tree after registry publication: pin the
corrected dependency, repeat both probes, finish the remaining acceptance and full gates, then
publish and verify owned-runtime parity. Never skip the enabled regression or ship the review archive.

## Что сделано

- [x] `src/agent/custom/` composes the published engine, canonical SQLite store, immutable host
      recipe, bounded artifacts/resources and exact model selection. No copied agent loop.
- [x] `src/chat/messageOperationSchema.ts`, `src/chat/messageOperationStore.ts` and Custom
      correlation preserve original message/run identity plus actual approval successor IDs,
      response-operation fingerprints, exact retries and changed-answer refusal.
- [x] `src/runtime/projectionSchema.ts`, Custom projection/content/history and
      `src/policy/runtimeProfile.ts` expose bounded structured evidence, actual model/tool/resource
      profile and authorized image references. Unsupported capabilities remain explicitly false.
- [x] `scripts/bundle-custom.ts` and `custom/package.ts` execute a digest-verified installed runner
      with packaged contained-files assets; package corruption refuses and concurrent materialization
      converges in `test/custom-package.test.ts`.
- [x] `scripts/custom-managed-acceptance.ts` passes real public create/message retries, signed
      approval with no early effect, worker restart while pending, stale generation and changed
      answer refusal, exact successor, daemon restart with the same identity, history and privacy.
- [x] Real vision uses `google/gemini-2.5-flash` and recognizes a red circle / blue square from
      pixels. Image digest `b07027a13fb6ab236a415ce5de540a9e617c2cdca0f2dccb94cb5fdaef3a069e`
      remains in authorized history; actual selected model is observed, not inferred.
- [x] `scripts/custom-coexistence-acceptance.ts` passes Codex → OpenCode → Custom → Codex over
      the existing authenticated chat lane, with all three exact provider/machine/session edges.
      Three isolated registrations and six processes are archived/stopped by verified cleanup.
- [x] `test/custom-projection.test.ts` proves duplicate/gap/epoch handling and bounded deltas;
      `test/custom-resources.test.ts` proves pinned resources, lazy skill discovery, applied profile
      persistence, private provenance and changed-source refusal.
- [x] `runtime/journalOwner.ts` integrates daemon and Custom worker ownership and private status.
      `test/runtime-journal-owner.test.ts` proves death-qualified recovery of a real prior process.
      `test/runtime-journal.test.ts` covers queue pressure, rotation, write failure, cancellation,
      partial tails, private mode and bounded shutdown. Metadata excludes prompt/tool/secret bodies.
- [x] `scripts/custom-resident-acceptance.ts` completes 901,309 ms with 100 sequential + 100
      concurrent reads and 180 periodic samples (380 reads total). Read p50 2.096 ms / p95 4.681 ms;
      status 27,901 bytes; canonical SQLite/WAL unchanged and no new model run. Worker CPU 56.41 s
      (6.259% of one core), RSS 181,056 → 210,672 KiB, maximum 210,784 KiB. This is measured cost,
      not a low-CPU claim or a speedup against an unmeasured baseline. Cleanup proves both processes
      exited. Candidate bundle SHA-256 `fac79bd769cc36be28c6588898e55f8c19c5a3f0960745216bc317f5137b02af`.
- [x] Complete the sequential-approval regression after the corrected published dependency.
- [x] Complete the remaining coding/deny/defer/interrupt and recovery acceptance; the current
      real managed coding lane passes through signed denial, queue admission and child cancellation.
- [x] Complete the final full green gate, release artifact and owned-runtime rollout.

Historical 0.70.1 gate: Biome and TypeScript passed; 980 tests passed, one sequential-approval test
failed, 4,966 assertions across 165 files. This is retained failed evidence, superseded by the
0.70.2 qualification above; it is not the current release decision.

Evidence SHA-256:

- Three-runtime route log: `bc7c8a64f173c8f6077f0447771cb81a972b98bc730d12c9eb855a8f1a8f5471`.
- Resident log: `bd0ce07805ff4c3b4053e742695b11ce5a62f3b35915ea256dd36e12dd09c438`.
- Full gate log: `f7f7e25d1a2f2aa00c478e500519027877cb07546712a8681a49ef15fe4cba63`.
- Published-only failing probe: `ecfb3416b21b4f8b13de8a59037ae0bdb54941ac621a8fbbf20b15f7459582b0`.
- Real-model failing coding probe: `f5a556356a860e38d26fc31c1ea75fc6a0e274c584c9e7c4e0a64161edaa9817`.

Resume from this working tree after the corrected dependency is published: re-run the enabled
approval regression first, finish coding/deny/defer/interrupt/recovery proofs, qualify the exact
final bundle and full gate, then continue the existing commit/publication/rollout conveyor.
The measured idle worker cost also needs profiling before making any performance claim.

### Independent control-contract qualification

The raw-door conformance slice is complete in
`../done/2026-08-30-ccmux-door-client-conformance.md`; the model source identity implementation is
qualified in `2026-08-30-ccmux-model-catalog-runtime-identity.md` and retains its publication items.
Both share this working tree, without a second model dispatcher or a private SDK dependency.
Focused checks pass 56 tests/265 assertions, including real receiver concurrency and lost-reply retry.
Live raw-door and native empty-registry catalog reads pass; the published 0.39.33 catalog omission
is separately reproduced through the downloaded client. Public frozen installation passes.
Final packed client SHA-256:
`9643ac8080c8fab828aa8ac48dd80c5fe4c82d69e2c7588d20a1bd6f6de96811` (58,677 bytes),
with install/Bun/Node/NodeNext/bundler all green. Final local bundle SHA-256:
`48e0935ca35364fad2297bb22cfdf813f3822647c567fa469dfbb99a02c2ae56`.
Final combined gate log SHA-256:
`b42873f04e6467038f9c637d87e5177de9fc08159d88d7841668f6c4b57aa26a`.
These are local qualification artifacts, not a new release. The sole full-suite failure remains
the enabled upstream signed-approval chronology regression; no independent implementation waits on it.

A separate bounded follow-up qualifies workspace semantics in
`../done/2026-08-30-workspace-facts-are-not-product-membership.md`: eight targeted tests/45 assertions,
TypeScript and Biome exit zero. Scheduling/control executable code is unchanged. The active-document
privacy correction is recorded in `2026-08-30-public-task-metadata-privacy-boundary.md`; historical
redaction stays outside that follow-up. No full-suite rerun or separate publication is claimed.

## Architecture and ownership

```text
typed control clients
        |
existing CCMux service / ingress / stream descriptor
        |
managed identity + admission + delivery + process supervision
        |
        +-- Codex adapter -------- App Server owns execution/history
        +-- OpenCode adapter ----- native server owns execution/history
        +-- Claude adapter ------- existing interactive runtime
        +-- Custom adapter ------- Stitchkit headless harness owns execution
                                        |
                                        +-- canonical SQLite conversation store
                                        +-- injected model resolver
                                        +-- host-authorized direct tools/resources
```

| Concern | Authority | Explicitly not another source of truth |
| --- | --- | --- |
| Managed address, registration generation, archive, restart | CCMux registry and create transaction | A harness-local list does not register or heal sessions |
| Custom conversation, runs, signed approvals, tool fences, history | One Stitchkit runtime and SQLite store per managed execution owner | No transcript copy or tool queue inside CCMux |
| Model/provider selection | Accepted CCMux selection mapped into immutable run metadata and resolved by the host | No model guess from session names; no provider through Codex by default |
| Credentials, filesystem/executable authority, OS isolation | Execution-host configuration | No caller-supplied environment, module path, executable or shell gateway |
| Public status/content | Bounded CCMux projection of native evidence | No inference from pane text, transport ACK or recent file activity |
| Diagnostic chronology | Bounded local metadata journal | Not admission, delivery, replay or durable business state |
| Network authorization and remote delivery | Existing declared-service transport | No parallel SSH/CLI gateway or new Socket.IO server |

## What to adopt and where

| Stitchkit surface | CCMux integration | Priority and payoff |
| --- | --- | --- |
| `createHeadlessAgentHarness` | New `src/agent/custom/` worker, existing `src/runtime/driver.ts` | P0: runnable Custom sessions without copying an agent loop |
| `createBunSqliteAgentRuntimeStore` | Private per-registration storage owned by that worker | P0: same conversation and accepted work after process recovery |
| Harness control connection and exclusive controller | Custom owner-local protocol behind current control handlers | P0: exact mutations, multiple observers, detach without stopping execution |
| Canonical Agent events, snapshots and browser cursor schemas | Custom adapters into `src/content/`, `src/context/`, `src/runtime/status.ts` | P0: truthful live/history/reconnect evidence with existing bounds |
| Signed durable approval continuation | `src/control/native.ts`, `src/runtime/`, `src/chat/messageOperation*` | P0: informed approvals and causal mapping across more than one native run |
| `createAgentCodingTools` | Host-selected Custom tool composition | P0: bounded read/search/guarded patch/command operations |
| `createAgentHarnessFileResources` and applied profile | `src/policy/` and Custom host composition | P0: declared resources, lazy skills and observable applied policy |
| Model catalog/registry, per-run resolver, optional OpenRouter leaf | `src/control/models.ts`, `src/runtime/selection*`, Custom catalog adapter | P0: catalog before first chat and durable model selection |
| `createDiagnosticJournal` | `src/runtime/diagnostics.ts`, process lifecycle and `src/daemon/application.ts` | P1: ordered finite evidence without exposing private payloads |
| Deferred direct-tool search | Custom tool profile only after a measured catalog-budget need | Later: large tool catalogs without a universal tool gateway |
| Optional TUI/controller package | A separately verified terminal attachment | Later: no renderer in the daemon or packed control client |

`createApplication`, managed resources/schedules, bounded channels, observability, contracts and
Unix transports are already used here. Upgrade their dependency and check their behavior; do not
present existing adoption as a new feature or replace working layers for novelty.

## Execution sequence

### 1. Exact dependency and package boundary

- Pin the published core artifact; update the normal dependency/lock from this checkout only.
- Inventory every existing import and run the complete current gate before adding Custom behavior.
  Current CCMux does not import Agent message unions, so the reported breaking union change is
  chiefly a requirement for the new adapter, not a reason for a parallel old client.
- Keep `ai` and any concrete model adapter inside the Custom execution entrypoint. Resolve and pin
  required peer versions from the chosen published contract; do not assume optional peers install
  themselves. Keep renderer, OpenTUI, React integration and provider credentials out of control clients.
- Prove actual packed Bun/Node/NodeNext/bundler consumers load with only their declared dependencies.
  A Custom worker may require the execution peers; a contract-only consumer must not.
- Package the runner as a durable installed artifact, never a process supervised from a scratch
  directory or dependency checkout. Record its version and digest beside the runtime bundle.

### 2. Custom host adapter and stable lifecycle

The adapter task owns this implementation. Expected modules are small ownership boundaries such
as `process`, `composition`, `admission`, `projection`, `catalog` and `control` under
`src/agent/custom/`; exact filenames follow their responsibilities rather than a required file count.

- Reuse existing create receipts, pending registration, native lease, process exit cleanup, archive
  and healing. Replace the unconditional Custom refusal only after real host preflight exists.
- Reserve managed registration and a stable native conversation identity before starting execution.
  Record native continuation separately from managed UUID, even if a fixture chooses equal values.
- Use one private SQLite store for that managed owner. A daemon/client restart does not open a
  competing writer. A provider-worker restart reopens the same store and conversation.
- Reuse `Session.envFile`, declared session environment, launch stamps, recipe revision/digest and
  application-policy references. Add a typed Custom host composition to the current configuration
  model; do not pass Custom settings through the Codex flags allowlist or create another secret loader.
- Preflight validates installed runner, explicit model adapter, resource/tool policy, storage and
  required credentials. Failure occurs before registry promotion/provider execution, with private
  cause evidence and a generic outward refusal.
- Recover only via the runtime's canonical recovery API. Resume queued evidence; keep an uncertain
  externally side-effecting attempt held unless native evidence proves replay safe. No blanket requeue.
- Shutdown stops admission, settles within declared budgets and reports unfinished work honestly.
  Archive stops the owned execution process but retains conversation and attachment evidence.

### 3. Model selection, resources and useful coding tools

- `models({ runtime: 'custom' })` works before the first conversation. An explicitly injected
  registry/catalog is the authority; OpenRouter is one optional adapter, not a new runtime kind.
- Persist effective selection before admission, independently from immutable launch authority.
  Resolve models from accepted run metadata and snapshot on recovery, not the host's current default.
  A later picker change affects later accepted work, not queued predecessors.
- Keep price, popularity, benchmark and modality observations separate with source/time. Missing
  price is not zero; popularity is not quality; catalog inclusion is not a successful tool/vision test.
  Retain Codex-native effort/tier/mode evidence without inventing equivalents for Custom.
- Use explicit resource roots and public provenance aliases. Instructions may be eager; skills and
  resources enter context as bounded summaries and are read by exact identity through `read_resource`.
  Bind resource contents to policy revision/digests before admission; mutable files cannot silently
  change accepted work. Recreate the resource loader on an accepted policy revision, not by guessing
  that its cached discovery rescans on each call.
- Mount real named coding tools. Use SHA-256-guarded `apply_patch` for changes; retain exact direct
  tool identity and the native tool fence. Unknown executable aliases and forbidden paths fail closed.
- Supply an explicit environment and finite executable map to `run_command`. A workspace root and
  realpath validation are not an OS sandbox; command authority can reach beyond cwd. Do not claim
  process isolation that the host has not actually configured and tested.
- Large tool output uses an opaque, registration-scoped artifact reference plus bounded preview and
  reads. Reuse compatible private storage utilities, but do not mislabel arbitrary output as an image
  or expose internal paths. Decide retention, archive access and quotas explicitly.
- Translate applied-profile evidence to the current policy projection: actual model, safe resource
  provenance and tool names. Diagnostics/text/credentials and approval signatures remain private.

### 4. Exact public control and the approval-continuation boundary

This is the highest-risk semantic integration, not a mechanical method rename.

- The CCMux worker holds the one mutation/controller path. User interfaces and service callers use
  that path; they do not each acquire a separate native controller. Disconnect detaches an observer,
  never calls `harness.close()` or starts another loop. Native control itself is transport-neutral,
  not an authenticated network server; use existing CCMux authentication/admission.
- Map `messageId` and principal to the canonical admission `inputMessageId`/`runId`. Same-ID retry
  reconciles the accepted native record, while changed input/profile/model/attachments conflict.
- A Stitchkit approval request ends its native run before the tool effect. The exact approval response
  is a new durable tool-role input and successor run. Do not mark the user's operation successfully
  complete merely because the request-producing run ended; do not overwrite its original `turnId`.
- Extend the single current correlation contract with bounded, typed request/continuation evidence
  where required: original binding, pending approval identity, response-operation identity and the
  actual successor run. Public operation settlement follows the canonical continuation; stream
  events retain their real native run IDs. No fake synthetic turn and no second execution journal.
- Bind decisions to registration, owner generation, conversation, approval ID and original call.
  The host supplies a stable private `toolApprovalSecret` for signed approval continuation across
  reopen. A new random secret on each process start would invalidate pending work. Signing is not
  considered enabled merely because the framework exposes an optional field.
- Map allow/deny through the canonical approval response and preserve duplicate/conflict behavior.
  Do not invent `acceptForSession` or a native user-question tool that this harness does not expose.
- `turn.interrupt` targets an actual active run. A pending approval whose run has already settled
  is rejected through the exact durable approval decision, not falsely interrupted as a live run.
  Publish capability/request-action evidence so a client can choose that operation explicitly.
- Keep FIFO/defer the normal message policy. `interrupt-next` is a distinct optional urgency policy
  with its own accepted identity, not same-turn steering and not automatic deletion of queued work.

### 5. Live projection, history and memory bounds

- Adapt canonical native events once into the current CCMux status/content/history contracts.
  Extract genuinely shared snapshot fields from Codex-owned schema modules if needed; do not leave
  a Custom adapter dependent on Codex-only protocol assumptions or add compatibility aliases.
- Separate durable snapshot version/event identity from transient runtime epoch/sequence. Gaps and
  changed epochs request canonical resync. Lost transport is unavailable, never success or idle.
- Use the existing bounded content buffer and its request/terminal protection. Kit's browser view
  reducer is a useful consumer primitive, not a ready-made bounded fleet cache: it concatenates
  transient text and retains conversation/run maps. Enforce existing CCMux byte/item/reader limits.
- Keep current tool observation semantics: native call identity, tool name, lifecycle, outcome and
  exit code. Unknown remains unknown; a successfully completed model turn can contain a failed tool.
- History comes from the Custom canonical store's bounded readers, not a copied transcript database.
  Filter public records structurally; raw tool input/output, signed approvals and private causes are
  not inserted into cheap monitoring snapshots.
- Retain authored image parts through the existing attachment service, exact message fingerprint and
  history resolver. Advertise Custom image support only after a real supported-model image test.
- Capability-map history, compaction, fork, steering, question input and approval actions separately.
  Availability of a framework function or a config callback does not prove a corresponding exact
  public operation. Unsupported operations refuse before mutation; no blanket native-parity claim.

### 6. Bounded diagnostic chronology

- Add `createDiagnosticJournal` as a managed local resource. Each writer owns a distinct file;
  daemon and worker processes never compete for one journal path.
- Capture allowlisted lifecycle/correlation metadata: create admission, native binding, projection
  generation, observer gaps, request suspension, cancellation, recovery and terminal classification.
  No prompt/reasoning bodies, tool arguments, credentials or raw provider responses in these records.
- Keep exact private native causes available through the existing diagnostic facility. A metadata
  journal does not replace or silently discard `recordRuntimeDiagnostic` details.
- Suggested initial journal budget, to qualify rather than claim measured: 8 KiB per event,
  256 pending items, 1 MiB pending bytes, 2 MiB per file and four retained files per writer.
  Record refusal counters, rotation/failure and partial-tail status; never hide a failed journal.
- Close/drain in application shutdown order. `accepted`, append completion, fsync, native ACK and
  message completion remain distinct facts. Never use this journal for delivery idempotency or replay.
- Reuse Kit's tested durable-operation/channel examples as review references for existing CCMux
  journals/outbox. Do not replace proven identity/admission stores with a new generic queue in this scope.

### 7. Combined acceptance and release readiness

Run this as one integrated native/Custom qualification program; avoid unrelated provider rewrites.

| Probe | Required evidence |
| --- | --- |
| Default native regression | Existing Codex/OpenCode and interactive Claude paths retain behavior and identities |
| Create + admission races | Same request, lost ACK, daemon restart and late retry produce one registration and one writer |
| Three-runtime coexistence | Real Codex, OpenCode and Custom sessions coexist; exact A→B→Custom→A reply identities |
| Real coding turn | Read/search, guarded patch and allowed command succeed; exit 7 remains a failed tool |
| Mutation refusal | Traversal, symlink, changed base digest, unknown executable and stale policy refuse before the effect |
| Durable approvals | Allow and deny; reopen while pending; correct signed continuation; wrong/stale identity and changed answer refused |
| Input/cancellation | Busy/defer, active-run interrupt and pending-approval rejection follow their different native semantics |
| Recovery | Same conversation, selection, resource revision and accepted work after daemon/worker restart; no duplicate side effect |
| Native stream | Multiple readers, reconnect, sequence gap and epoch change; canonical resync and bounded memory |
| Identity/privacy | Exact message/run/request correlation; positive secret-like fixture absent from argv/public metadata/journal |
| Host output storage | Bounded preview/read, cross-registration refusal, quota exhaustion and retained history references |
| Diagnostics | Full queue, file rotation, failed writer, partial tail, cancellation and bounded shutdown are observable |
| Packaging | Actual installed tgz on Bun/Node/type consumers, plus installed Custom execution entrypoint |

- Measure a 15-minute resident window and a fixed sequential/concurrent read batch. Report actual
  CPU/RSS/latency and record/byte ceilings; no claimed speedup without a matched baseline. Reads of
  prepared status must not invoke a model, spawn a CLI or rescan transcripts.
- Native live tests use isolated owned fixtures and disabled user-facing mirroring. Cleanup proves
  all fixture processes stopped while unrelated registrations and starts are preserved.
- Publish from the canonical checkout, run full local and exact-SHA CI
  gates, verify actual published artifacts and roll out all owned installations. Verify version,
  runtime/runner/client hashes, live owner projections and preserved preexisting session starts.
- On each host, distinguish installed runner from configured provider and working credentials.
  A missing host model configuration is not evidence that a live Custom session succeeded there.
- Cross-machine checks use the declared-service lane when its owner activation is available. The
  existing [image task](2026-08-30-managed-image-attachments.md) and its
  [roadmap](2026-08-30-native-harness-control-parity.md) retained their own external
  transport acceptance. A library upgrade alone does not satisfy that acceptance.

## Optional subsequent work, not first-release blockers

1. **Terminal client:** evaluate the published `stitchkit-tui` when available. Prove attachment to
   the same managed conversation/controller; the stock fresh-launch behavior must not create a new
   conversation on supervisor restart. If its supported API cannot attach without another writer,
   request the narrow owner seam rather than copying its UI or using private hooks. Do not replace
   the fleet TUI just to display one Custom conversation.
2. **Large catalogs:** adopt `createDeferredAgentToolSurface` only for a measured tool-schema/context
   budget problem. A small direct coding-tool set does not need search indirection.
3. **Additional model adapters:** use the injected resolver for an already configured external or
   local endpoint. No new credential transfer, endpoint invention, LAN exposure or subscription proxy.
4. **Richer consumers:** browser-safe cursor/reducer and safe catalog metadata can support a shared
   conversation view. Consumer UI/deployment stays outside this owner plan.

## Explicit non-goals

- No conversion of Codex/OpenCode into Stitchkit agent loops; no replacement of subscription auth.
- No claim that official Desktop-owned sessions become controlled by CCMux through this release.
- No new product prompts, tools marketplace, inference proxy, model router or general command gateway.
- No new SSH/CLI data path, Socket.IO layer, listener port or transport authorization policy.
- No use of `RealtimeRequestOptions.onPhase` as model progress: that callback describes Socket.IO
  request transport, and CCMux's present owner path is Unix/declared-service, not that client.
- No database rewrite of existing native history or delivery ledger, and no diagnostic journal as WAL.
- No v1/v2 routes, legacy aliases or dual permanent client paths. Durable identities still survive
  explicit bounded state migrations; an API break is not permission to lose accepted work.

## Plan acceptance

- [x] Verify published version, exact source, archive integrity and required export files.
- [x] Map new primitives to actual CCMux modules and identify non-mechanical semantic boundaries.
- [x] Reuse the existing Custom adapter task and separate external image/TUI boundaries.
- [x] Complete dependency/packaging cutover and all current regression gates.
- [x] Complete Custom runner, immutable host composition and real persistent conversation acceptance.
- [x] Complete exact approval continuation, correlation and capability-aware public operations.
- [x] Complete bounded projection/history/diagnostic integration and privacy/adversarial probes.
- [x] Complete combined installed/published E2E and authorized fleet rollout with exact evidence.

## Published completion

Release `v0.39.34`, implementation `6d89daea6974fbae90e99ac9665f197e8a19dd93`,
release/tag `3258d7bb0f960fe5e9380395c35ff605364f8cfe`. Exact-SHA CI runs
`33339092883` and `33339092898` passed, including bundle smoke and publication.
The [post-rollout verification artifact](https://github.com/max-listov/ccmux/releases/download/v0.39.34/post-rollout-verification.json)
records downloaded bundle/client hashes, five packed consumers, real Custom coding and the
Codex → OpenCode → Custom → Codex route. All fixture processes exited with no notification sink.
All three owned installations match the bundle; 34 preexisting running identities and uptimes
are preserved. Daemons/producers are live and diagnostic journals report no failures.
Host deployment does not imply a Custom provider credential/profile has been enabled everywhere.
The separately scoped image transport acceptance and historical privacy follow-up remain open.

## Primary references

- [Core release and migration notes](https://github.com/max-listov/stitchkit/releases/tag/v0.70.0)
- [Harness ownership](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/docs/decisions/0130-headless-harness-composes-the-agent-runtime.md)
- [Durable approvals, controller and resources](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/docs/decisions/0131-harness-leaves-preserve-canonical-agent-identity.md)
- [Harness implementation](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/packages/core/src/agent-runtime/harness.ts)
- [Control and cursor implementation](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/packages/core/src/agent-runtime/control-schema.ts)
- [Model catalogs and selections](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/packages/core/src/agent-runtime/models.ts)
- [Diagnostic journal contract](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/docs/decisions/0134-diagnostic-journal-is-bounded-local-evidence.md)
- [Optional TUI ownership](https://github.com/max-listov/stitchkit/blob/5eb57b159de92e2ba708d189b96911b565b4af82/docs/decisions/0133-agent-tui-is-an-optional-package-over-one-controller.md)
