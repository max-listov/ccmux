---
title: Own the native Codex runtime without replacing its harness
description: An opt-in App Server transport preserves provider identity and interactive CLI capabilities under the existing supervisor.
type: decision
status: active
created: 2026-08-28
updated: 2026-08-28
---

# Ownership

`runtime: app-server` is an opt-in mode for managed Codex sessions. Absence of this field keeps
the ordinary TUI launch. The existing per-session supervisor owns one real `codex app-server`
process and an attached native CLI client. Each session keeps its own process environment,
working directory, permissions and chat capability; sharing a process across differently
configured sessions would leak process-level configuration between them.

The provider listens on a private, instance-and-session-specific Unix socket. The native TUI
attaches with `resume --remote` to the exact UUID. Detaching a terminal or restarting the CCMux
daemon does not restart this writer. A provider restart resumes the same persisted UUID; failed
or mismatched admission blocks the session rather than creating a replacement conversation.

# State and messages

One resident observer per runtime consumes native notifications and bounded metadata reads.
Its snapshot carries provider/thread identity, process and connection generation, sequence,
observation time and expiry. A reconnect establishes a new generation before reconciliation;
an older snapshot cannot overwrite a newer event. Readers consume prepared state, never spawn
a CLI or scan conversation bodies to discover whether a turn is working.

Native states distinguish working, idle, waiting-approval and waiting-input. Missing evidence,
process death, expired evidence and unknown native flags fail closed. A persisted transcript is
conversation history, not live state. The existing monitoring projection and CLI/TUI use this
authority for App Server sessions; ordinary TUI sessions retain their current observation path.

The existing immutable chat ledger and exact provider/machine/session identity remain the
coordination boundary. Native `turn/start` carries the immutable message ID. Intent is durable
before submission; acceptance, turn start, completion and interruption are distinct facts.
An ambiguous submission is reconciled by exact persisted provider evidence, not blindly retried.
CCMux serializes delivery and gates the attached CLI's input while checking its composer.
`canAcceptDirectInput` describes provider admission policy, not client typing or a blank composer.

# Boundaries

Happy and CodexMonitor are references for snapshot/event reconciliation and native protocol
handling. CCMux does not install them, copy their replacement inference harness, operate their
relay or import their accounts. Authentication stays with the installed native Codex binary.

Existing Desktop-owned threads are not adopted or resumed by this mode. History visibility in
the official Desktop is not simultaneous live attachment. No private Desktop channel, application
patch, peer-authorization bypass or second writer is part of this decision.

Consumers get a public-safe, bounded owner contract. Consumer deployments and a full replacement
desktop/mobile application are not part of this runtime implementation.
