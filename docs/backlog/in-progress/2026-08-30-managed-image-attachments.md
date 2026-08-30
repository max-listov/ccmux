---
title: Image attachments through managed native control
description: Deliver image-only and text-plus-image input to managed Codex and OpenCode through bounded authenticated attachment references.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
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

T3 Code separates [attachment upload](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/assets/AttachmentUpload.ts)
from [attachment identity/storage](https://github.com/pingdotgg/t3code/blob/8dcb96314c976899e4df6951fb9af03131c2a46f/apps/server/src/attachmentStore.ts).
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
- [ ] Publish the typed local/service clients, descriptor, attachment retrieval contract for
  authorized previews, architecture and minimal runnable consumer example. Keep bytes out of cheap
  status snapshots; expose safe reference metadata there only when needed.

## Acceptance

- [x] Through the public service client, both real Codex and OpenCode sessions identify visual
  details in a deterministic PNG/JPEG fixture. Expected details are not leaked in prompt text,
  filename or metadata. Native evidence confirms image input, not shell/OCR substitution.
- [ ] Repeat with image-only, text-plus-image and ordered multiple images, including an ordinary
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
- [ ] Current text input and interactive sessions pass regressions, without legacy client paths. Packed Bun/Node clients,
  complete local gates and exact-SHA CI pass; release/artifact hashes and owned rollout parity are
  recorded against real image E2E, not merely an accepted upload receipt.

## Boundaries

No image generation, PDF/file-format expansion, UI implementation, external object-storage account,
provider credential changes or Custom-runtime dependency. This is the first integration slice of
the [native control roadmap](2026-08-30-native-harness-control-parity.md).

## Что сделано

Final integrated native rerun passed with exact ordered image inputs on both runtimes in both
directions: `[PNG, JPEG]` and `[JPEG, PNG]`, semantic recognition and exact-turn history references.
Same-ID reordered input refused with one accepted ledger entry. The 8,112,933-byte PNG retained
bounded history (10,409 bytes) and stream (6,463 bytes). Two fixture registrations archived and all
five tracked processes stopped. Evidence SHA-256:
`72ecc84bc713bbe2bcad6f52e1c3252c1a642f2bbae12e92e92dc619a8b6f9ea`.
The remote-machine portion of the combined acceptance item is still open; local service ingress
is not relabelled as cross-machine transport acceptance.

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
- [ ] Cross-machine image proof waits for the external transport's current descriptor/profile
  activation described in the umbrella task. Local service E2E is not labelled remote acceptance.
