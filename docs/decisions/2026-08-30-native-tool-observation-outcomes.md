---
title: Separate native tool lifecycle from outcome
description: One bounded observation contract retains exact tool identity and authoritative result evidence.
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# Context

A native tool can complete with a nonzero shell exit or fail inside an otherwise completed turn.
Projecting only the lifecycle loses this distinction. Tool input/output parsing would duplicate
provider semantics, expose private payloads and invent outcomes where native evidence is absent.
OpenCode part identity and call identity also differ; replacing one with the other breaks joins
between live updates and native history.

# Decision

Use one `ToolObservationSchema` in content and history. Separate the lifecycle from an explicit
known/unknown outcome; retain a bounded tool name, native call ID and optional observed exit code.
Preserve native item identity in the containing record. Share each provider's mapper between live
and history paths. Codex App Server 0.151.0 typed item statuses/result fields and OpenCode 1.18.20
tool state metadata are the authority, never the parent turn or text in a command/output/error.

Native `item/completed` ends an observed lifecycle, not necessarily a successful operation. Without
an explicit result/status contract, outcome is unknown. Nonterminal observations never claim a
result. Later incomplete observations do not erase retained terminal evidence. Existing cache and
history size/retention bounds apply; no unbounded tool registry is introduced.

Raw commands, inputs, outputs, errors, result payloads, arbitrary metadata and credentials remain
outside this object. The adapters read only the allowlisted structured evidence necessary for the
typed fields. Both current clients and the native stream carry the same schema without aliases or
numbered alternatives.

# Verification

Golden tests cover zero/nonzero exit, failure, decline, interruption, missing evidence, tool names,
part/call identity, payload omission and reconnect/late-update semantics. The isolated acceptance
script executes two separate real shell calls through each managed runtime and the public client,
compares live/history/reconnect evidence, and verifies identity/outcome after daemon/provider restart.
Its readiness check requires a live new runtime generation, not a cached idle row after restart.
