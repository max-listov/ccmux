---
title: Supervise native runtimes without owning their agent loops
description: Separate managed identity, native continuation and inference selection behind one capability-aware control plane.
type: decision
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Decision

Keep one managed registry, transactional create journal, chat ledger, request mailbox and daemon.
Runtime selection is explicit (`claude`, `codex`, `opencode`, optional `custom`) and independent of
`modelSelection`. Omitted runtime still creates native Codex. Interactive Claude retains its current
protocol; it does not gain fabricated structured approval/input capabilities.

An OpenCode driver owns an authenticated loopback server process and its SDK/SSE observation.
Managed UUID/registration generation and native `ses_…` continuation are separate immutable
identities. Native create intent is persisted before POST. A lost admission response reconciles an
exact native record; missing or ambiguous evidence refuses replacement. Prompt and response
uncertainty never causes automatic repetition of side effects.

No caller-supplied executable, endpoint, shell, authentication value or env-file path is added to the
control service. Native host configuration supplies provider accounts and permissions. Existing
Codex launch recipes remain Codex-scoped; unsupported runtime/profile combinations fail closed.

The optional custom adapter must consume a published Stitchkit harness entrypoint. Unpublished
source or an example runner does not satisfy this dependency. Until publication and real acceptance,
capability discovery reports unavailable and create refuses before mutation. No copied inference,
tool, retry or prompt loop is introduced to make that checkbox appear complete.

# Alternatives rejected

- Routing every inference provider through Codex conflates runtime and model identity.
- Adopting an arbitrary server URL loses ownership and restart authority.
- Parsing OpenCode's TUI discards native request IDs and terminal evidence already available in API.
- Recreating sessions after uncertain responses risks a second writer or duplicated tool effects.
- Replacing CCMux's chat ledger with a runtime-specific queue duplicates delivery authority.
- Renaming the package or deploying another product is not required by this adapter boundary.

# Consequences

The existing transport envelope remains runtime-neutral. Clients discover capabilities and select a
runtime using published typed schemas. Structured frames have bounded retention and explicit resets;
EOF, stale leases and native idle without terminal evidence cannot report successful completion.
Daemon restart preserves native writer processes; provider restart resumes the exact native history.
Archive disables healing and retains both identities and provider history. See
[the driver contract and operational limits](../architecture/managed-runtime-drivers.md).
