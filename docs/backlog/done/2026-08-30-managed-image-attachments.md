---
title: Image attachments through managed native control
description: Deliver image-only and text-plus-image input to managed Codex and OpenCode through bounded authenticated attachment references.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31 19:14 +0700
priority: P1
pipeline: native-harness-control
order: 1
depends-on: —
---

## Why

`ControlMessageSchema` in `src/control/schema.ts` accepts only a nonempty text body. The mailbox in
`src/runtime/input.ts`, OpenCode `parts` in `src/agent/opencode/input.ts` and managed Codex pickup
also carry text. Sending an image path as prose is not native image input, particularly when the
caller and execution host do not share a filesystem.

`src/control/serviceDescriptor.ts` limits the service envelope to 64 KiB and `message.send` to
32 KiB. Base64-embedding ordinary screenshots in that message or globally enlarging every control
request is not an acceptable attachment design.

the external reference harness separates attachment upload
from attachment identity/storage.
Its Codex adapter resolves stored images into native image input, and OpenCode maps attachments
to native file parts. Adopt the separation, not its URLs, framework or generic-file prompt fallback.

## Result

- An authorized client transfers image bytes to the execution host, receives an opaque immutable
  reference and sends ordered image references with optional text through the same control plane.
- Image-only, text-plus-image and multiple-image turns work. Empty text with no images is invalid.
  Text-only input uses this same contract; retained accepted-message fingerprints preserve retry safety.
- Runtime/model capabilities and concrete limits are discoverable. PNG and JPEG are required;
  WebP and other formats are advertised only after native support is proved. Unsupported image
  models or formats fail explicitly, never silently drop the image or replace it with OCR/text.

## State and ownership

Attachment: `uploading → verified → retained → eligible-for-cleanup`; incomplete uploads can become
`cancelled/expired`. The owner verifies total bytes, media signature, dimensions/pixel budget and
digest before a reference becomes usable. A message atomically pins verified references before
durable acceptance. Cleanup cannot remove accepted/deferred/uncertain inputs or attachments needed
by retained history. Archive alone is not permission to delete conversation assets.

Message: existing `queued → dispatching → accepted/uncertain → terminal` semantics remain. Its
fingerprint includes ordered immutable attachment identities/digests, not a mutable caller path.
Retry with another image is a conflict. Native admission uncertainty never causes automatic resend.
Managed registration, sender authority and execution-host scope gate attachment use and retrieval;
an opaque ID is not itself authorization. Native history remains the conversation authority.

## Plan

- [x] Specify the typed upload/finalize/read-reference lifecycle and limits in an ADR. Prefer bounded
  authenticated chunk operations through the existing declared service where they fit published
  transport primitives; do not invent a separate file server or raise unrelated request limits.
  Publish count, per-image/aggregate bytes, chunk size, TTL, concurrency, cancellation and disk quotas.
- [x] Implement owner-private atomic attachment storage under the existing state root, immutable
  digest verification, interrupted-upload recovery, reference retention and bounded cleanup. Reject
  traversal, symlinks, caller-selected filesystem paths and arbitrary remote URL fetches.
- [x] Extend message/ledger/native mailbox schemas and exact retry fingerprints with references.
  Preserve causal order and image retention through defer, approval/input waits and process restart.
- [x] Map bytes/references into native Codex image items and OpenCode image file parts. An internal
  provider-local path or data URL may be required by its protocol; neither is caller authority nor
  something to expose in receipts, monitoring metadata, argv or diagnostic logs.
- [x] Add granular image capabilities and model-modality checks using the provider's documented
  version-specific behavior; missing modality metadata must not be guessed into universal support.
- [x] Publish the typed local/service clients, descriptor, attachment retrieval contract for
  authorized previews, architecture and minimal runnable consumer example. Keep bytes out of cheap
  status snapshots; expose safe reference metadata there only when needed.

## Acceptance

- [x] Through the public service client, both real Codex and OpenCode sessions identify visual
  details in a deterministic PNG/JPEG fixture. Expected details are not leaked in prompt text,
  filename or metadata. Native evidence confirms image input, not shell/OCR substitution.
- [x] Repeat with image-only, text-plus-image and ordered multiple images, including an ordinary
  screenshot larger than the current message envelope and a near-limit image. A remote execution
  host succeeds with bytes originating on the client, without a shared path, SSH or CLI upload.
- [x] Same-ID retry and lost reply produce one native input. Changed bytes/order conflict; corrupt,
  incomplete, expired-unretained, wrong-scope and unsupported attachments refuse before dispatch.
- [x] Deferred input survives daemon/provider restart with the same identity and image digest.
  Busy/approval/input gates still hold; uncertain dispatch is reconciled without duplicate turns.
- [x] Authenticated preview/read works after reconnect; unauthorized or cross-target access fails.
  Cancellation, disk exhaustion, chunk duplication/reordering and cleanup races are covered.
- [x] Secret-like fixture data and storage paths are absent from outward diagnostics, public metadata
  and argv. Image bytes appear only in the authorized attachment/native-content paths that need them.
- [x] Current text input and interactive sessions pass regressions, without legacy client paths. Packed Bun/Node clients,
  complete local gates and exact-SHA CI pass; release/artifact hashes and owned rollout parity are
  recorded against real image E2E, not merely an accepted upload receipt.

## Boundaries

No image generation, PDF/file-format expansion, UI implementation, external object-storage account,
provider credential changes or Custom-runtime dependency. This is the first integration slice of
the [native control roadmap](2026-08-30-native-harness-control-parity.md).

## Completion qualification

Use a configured, authenticated execution host through its existing declared service binding.
Create distinct test workspaces and managed identities; preserve every preexisting session and
service binding. Explicit `notification: conversation` on each accepted input prevents fixture
messages from becoming owner notifications. Credentials and host configuration are not changed.
The caller generates image bytes locally, transfers them only through attachment operations, and
verifies exact native turn correlation, near-limit input, preview/history and final archive.

## Что сделано

Final integrated native rerun passed with exact ordered image inputs on both runtimes in both
directions: `[PNG, JPEG]` and `[JPEG, PNG]`, semantic recognition and exact-turn history references.
Same-ID reordered input refused with one accepted ledger entry. The 8,112,933-byte PNG retained
bounded history (10,409 bytes) and stream (6,463 bytes). Two fixture registrations archived and all
five tracked processes stopped. Evidence SHA-256:
`72ecc84bc713bbe2bcad6f52e1c3252c1a642f2bbae12e92e92dc619a8b6f9ea`.
This was local-service evidence. The later cross-machine completion below supplies the distinct
remote acceptance; local ingress is not relabelled as cross-machine transport.

- [x] `src/attachments/` implements bounded private upload, full decoding, atomic retention,
  authorized preview and exact image identities. `test/attachments-*.test.ts` covers refusal/races.
- [x] `scripts/native-image-steering-acceptance.ts` proves actual PNG/JPEG visual recognition on
  Codex 0.151.0 and OpenCode 1.18.20, image-only input, exact preview and restart-safe native history.
- [x] A real OpenCode PNG of 8,112,933 bytes / 2,371,600 pixels passed; native history was 5,395 bytes
  and the prepared stream frame 4,394 bytes. Sampled worker RSS was 182,320–210,400 KiB.
- [x] `src/agent/opencode/imageElision.ts` bounds native inline-image echoes before SDK allocation;
  `test/opencode-image-elision.test.ts` covers limits without widening ordinary response budgets.
- [x] `src/context/history.ts` preserves native image order independently of pin insertion order;
  `test/history-image-order.test.ts` covers reversed/repeated pointers and registration isolation.
- [x] Complete the remaining remote OpenCode/near-limit cases on an execution host with existing
  working provider authentication. No credential repair or transfer was needed; evidence follows.

### Historical transport preflight (2026-08-31; superseded below)

The remote node now declares the current 26-operation control service and native profile;
the earlier old-descriptor finding is superseded. Its binding reaches the production daemon,
whose configured notification mirror broadcasts every admitted chat message. The acceptance
mandate explicitly requires isolated fixtures without user-facing test notifications. No fixture
message was sent, notification cursor changed or production mirror disabled. Cross-machine
mutating acceptance still needs an isolated transport binding; production read operations do not.

### Real isolated cross-machine follow-up (2026-08-31)

The isolated-binding boundary was resolved for a bounded live probe using the published
`v0.39.34` runtime/client, existing service lane and a separate daemon without notification sinks.
No working production service binding was replaced. Image bytes originated on the caller machine
and crossed `attachment.begin/chunk/finalize/read`; no shared path, SSH or CLI image upload.

Real remote Codex passed PNG/JPEG recognition, image-only and text-plus-image input, ordered
multiple images, exact preview, same-ID create/message retry and retained native history references.
The remote OpenCode upload/preview also passed, but its configured provider rejected authentication
on the first model turn. The exact native diagnostic is retained privately; a catalog entry and
successful upload are not model success. No credentials were copied or changed. The large-image
remote case was not reached. Evidence SHA-256:
`d2da18a7a5194decafde9f7e0119f1a0825f320ebbdb83df6039b7f0603dd7d5`.

All three fixture registrations were archived, the isolated daemon/tmux processes exited, and
the temporary binding plus 13 fixture grants on each relevant policy were removed while retaining
unrelated configuration. A subsequent unauthorized route returned `denied / not-dispatched`.
The production daemon and its preexisting running sessions were preserved. This narrows the
remaining boundary to host authentication and the unperformed remote cases, not transport support.

### Cross-machine completion (2026-08-31)

`scripts/remote-image-acceptance.ts` and `scripts/remote-image-operations.ts` now provide the
generic acceptance through the typed public service client. An existing declared service lane to
an authenticated execution host, running the published `v0.39.38` bundle, passed on real Codex
(`gpt-5.6-luna`) and OpenCode 1.18.25 (`google/gemini-2.5-flash`). Client-generated bytes crossed
only attachment operations. No service binding, host configuration, credential or existing session
was changed. Every input explicitly selected conversation-only notifications.
The owner mirror recorded suppression for all ten exact test message IDs and zero deliveries.

Both runtimes recognized PNG/JPEG, text-plus-image, image-only and ordered pairs in both directions.
The lossless PNG was 1,180,275 bytes, JPEG 27,433 bytes and near-limit PNG 8,112,933 bytes.
Same-ID create/message retry retained one identity/input; reordered images under the same ID
refused. Exact message-to-native-turn correlation, ordered history and byte-identical retained
previews passed. The near-limit turn kept history/native snapshots bounded: Codex 6,207/8,170 bytes,
OpenCode 9,717/6,712 bytes. Image bytes were absent from the native projection.

The initial combined probe completed all Codex cases but failed before OpenCode input; its cleanup
ran concurrently on a single-inflight transport and masked the primary error. That run is not
reported as overall success. The runner now preserves primary and cleanup failures and archives
sequentially. Both initial registrations were then archived successfully. The separate OpenCode
repeat completed every case and archived its fixture with zero cleanup failures. All 15 preexisting
running sessions retained their identity and remained running; all three test registrations stopped.

Private evidence SHA-256: Codex plus retained failed combined probe
`3a62355414a3b07626a4292ca1d9eb1cf971151ffdfa0251f2cff2f7b7249258`;
complete OpenCode repeat
`dae29d8c1a023c5d3aefe69b7ea69a575468c67c7750195e36fe6da331eb9e26`.
Raw host/session addresses and provider diagnostics remain private. The earlier authentication
failure belongs to a different host and no longer blocks this scoped acceptance.

The completion package passed 1,006 tests and 5,164 assertions across 170 files, including packed
installation, browser-safe imports, Bun/Node and TypeScript NodeNext/Bundler consumers. Publication
qualification records the final release SHA, downloaded artifacts and post-rollout checks separately.

## Published acceptance

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
