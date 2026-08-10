---
title: Peer routing and session identity
description: Canonical identity and transport boundaries for ccmux-managed sessions and Codex Desktop tasks
type: architecture
status: active
created: 2026-08-10
updated: 2026-08-10
---

# Peer routing and session identity

Provider, source, address, and capability answer different questions. They must not be collapsed
into a cwd-based guess.

| Dimension | Question | Examples | Routing role |
|---|---|---|---|
| Provider | Which agent runtime owns the conversation? | `claude`, `codex` | Selects launch, transcript, pane, and lifecycle adapters. |
| Source | Which system emitted the identity/message? | `ccmux`, Codex Desktop | Names the source of truth; it is not a provider. |
| Coordination plane | Which routing contract is active? | `ccmux-managed`, `desktop-native` | Selects the discovery, addressing, and delivery operations. |
| Address | Which exact managed session is the target? | `host-a:agent-a` | Routes a ccmux command to one registered session. |
| Capability | What can that source/provider pair actually do? | managed chat, wait, native Desktop task messaging | Decides which operation is legal; capability is not identity. |

Two sessions can share one project directory while using different providers or sources. Therefore
cwd, project name, model name, and recency are never routing keys. `ccmux list --json` requires an
`agent` field for every local session. `ccmux fleet` preserves the field from peers; if an older peer
does not send it, the human view says `unknown` instead of silently claiming Claude.

## ccmux-managed plane

The human selector is the exact `<machine>:<session>` address. At send time it resolves to and pins
`source + machine + provider + session + thread UUID`; queued delivery and retry validate that full
endpoint, so reusing a name cannot redirect mail. A bare session name means the current machine only.
ccmux owns the registry, tmux persistence, daemon self-heal, transcript
adapter, wait state, and managed routing identity for these sessions. Claude currently has a
calibrated pane chat adapter; Codex targets fail explicitly until the separate managed-Codex chat
task supplies equivalent delivery detection. Identity support never implies a delivery capability.
The provider remains visible next
to the address so a human or agent can choose deliberately between, for example,
`host-a:agent-a` (`claude`) and `host-a:agent-b` (`codex`) in the same directory.

The address selects the target; provider and UUID validate and pin it. Provider is not added
as an alternative address syntax, because parallel address forms would create two sources of truth.

Each v2 chat envelope carries full structured `from` and `to` identities. Remote send resolves the
target once, then receiver and retry use that same immutable provider+UUID endpoint. The receiver
serializes idempotency check+append, so concurrent retries produce one ledger row. A rotating
per-runtime capability prevents a shell that merely self-sets `CCMUX_SESSION` from being promoted
from `cli` to a managed sender. SSH is the remote admission boundary. These mechanisms prove ccmux
process/routing provenance, not security against a hostile process with the same OS user, which can
read ccmux state; provider metadata never increases trust.

The active state bundle is `chat-v2.jsonl`, `chat-cursors-v2.json`, `chat-ack-v2.jsonl`,
`outbox-v2.jsonl`, and `outbox-ack-v2.jsonl`. Unversioned files remain ignored archives because their
name-only rows cannot be upgraded without inventing provider and UUID. Lifecycle operations are not
chat: `restart --then` does not exist, and a work hand-off must use a recorded `msg` envelope.

## Desktop-native plane

A Codex Desktop task is owned by the Desktop app and addressed by its native task ID. Coordination
uses the task tools injected into that Desktop task. Desktop process lifetime, task discovery, and
native task messaging are not ccmux registry state.

The boundary is intentionally zero-ledger: ccmux does not copy Desktop messages into its managed
chat ledger, and it does not synthesize managed chat records for native Desktop calls. This avoids
duplicate delivery, conflicting unread state, and false claims that a Desktop task is daemon-healed.
If a workflow needs both planes, the caller must name the target source and exact identity; a shared
cwd is not a bridge.

## Capability-driven routing

1. Identify the coordination plane: `desktop-native` or `ccmux-managed`.
2. Resolve the exact native task ID or ccmux fleet address from that source's own discovery surface.
3. Confirm the provider/capability shown by that surface.
4. Invoke only the source-native operation.

Missing provider metadata is `unknown`. It may be displayed for version-skew diagnostics, but code
that requires a provider adapter must fail explicitly rather than defaulting to Claude.

| Plane / API | Discover | Write | Wait | Status meaning |
|---|---|---|---|---|
| `ccmux-managed` | `ccmux list/fleet` | `ccmux msg` only when the provider exposes managed chat | `ccmux wait` | `idle/working/stopped` are ccmux lifecycle/pane states. |
| `desktop-native` | Desktop task list/read tools | Desktop native task send tool | Desktop native task wait tool | Native task state belongs to the Desktop host. |
| Codex App Server observer | `thread/list/read` | No write capability is inferred from visibility | Protocol-specific | `notLoaded` is process-local and does not mean dead, unowned, or writable. |

Transcript visibility is read capability only. It never grants write ownership or authorizes moving
a native task into the managed registry.
