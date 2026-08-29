---
title: Keep managed control launch policy on the execution host
description: A public create request selects an immutable recipe identity while the host retains every launch-affecting value.
type: decision
status: active
created: 2026-08-29
updated: 2026-08-29
---

# Decision

`session.create` may carry `launchRecipe: { id, revision }`. This reference is the complete caller
authority. The execution host resolves it from `machine.json`; the request cannot contain a recipe
definition, environment path, executable, shell text, provider credential or secret value. A create
with a recipe also cannot carry caller flags, because flag ordering would let the caller override the
owner policy while appearing to use it.

A host recipe contains one revision, the existing session `envFile`, native Codex/App Server flags,
required environment variable names and public-safe capability identifiers. Native flags go through
the same `ownedCodexFlags` allowlist as every owned App Server launch. Provider credentials remain
environment values: native model-provider configuration names an `env_key`; it never puts the value
in argv. This matches Codex's machine-local provider boundary: provider/auth configuration belongs
to user-level configuration, and a profile/provider is selected by name rather than copied into a
project or request.

# Resolution and identity

The host canonicalizes the definition and computes a SHA-256 digest. Safe metadata
`{ id, revision, digest, capabilities }` is persisted on the session and durable create receipt.
The already-existing `Session.flags` and `Session.envFile` remain the executable launch truth; there
is no second environment loader or provider launcher.

Resolution and availability checks happen before the create receipt, pending registry transaction
or provider spawn. An unknown/removed revision, missing or unreadable declared environment source,
missing required environment name, reserved environment name or refused native flag returns the
single public `LAUNCH_RECIPE_UNAVAILABLE` error. Exact reason is retained only in the owner log.

The request fingerprint includes the resolved digest. A retry with the same request ID reconciles the
same registration generation and writer. If the active definition changes without changing the
accepted request, the digest conflicts; it cannot silently rewrite the operation. Before every
managed App Server spawn, the persisted metadata, flags and env file are rechecked against the
current host recipe. An unchanged recipe resumes the pinned UUID. A removed or edited recipe blocks
before spawn rather than starting a differently configured writer.

# Projection boundary

Create receipts, session status and native snapshots may include only the safe metadata. Definition
fields, env-file paths and contents, required environment names, provider credentials and values are
never projected. Recipe-less creates omit the field entirely, preserving the revision-1 default
contract for existing clients and ordinary managed Codex sessions.

The declared-service descriptor keeps its existing operation/effect identities. The additive field
ships through the same schema-derived local client, injected-fetch service client and packed Bun/Node
package; it does not add a service operation, grant, transport, retry policy or writer.
