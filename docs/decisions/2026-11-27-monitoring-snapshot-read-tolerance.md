---
title: The monitoring snapshot is written strictly and read tolerantly; control answers stay one strict contract
description: Two schemas for the protocol-1 monitoring snapshot — the producer's, which requires every field it writes, and the reader's, which reads an unknown state or agent as unknown and drops unknown fields — and no tolerance anywhere else.
type: decision
status: active
created: 2026-11-27
updated: 2026-11-27 21:45 +0800
---

# Decision

`monitoring-status.json` has two schemas in `src/monitoring/schema.ts`:

- **`MonitoringRowSchema` / `MonitoringSnapshotSchema` — the producer's.** Every field the daemon
  always writes is required; the daemon checks each row it publishes against it.
- **`MonitoringRowReadSchema` / `MonitoringSnapshotReadSchema` — the reader's**, used by
  `readMonitoringStatus` and exported from `stitchmux/monitoring-reader`. A `state` or `agent` the reader
  does not know reads as `unknown`; a field it does not know is dropped; a field added to rows after
  protocol 1 may be absent. Identities, timestamps, bounds, `limits` and the protocol number stay
  strict: a row that breaks them is broken, not newer.

The control API's answers (`ControlRowSchema` and the rest of `controlContract`) get no such
tolerance. A field the daemon always sends is required there.

# Why

The snapshot is the one piece of data here that two versions read on the same machine at once: the
installed daemon writes it, and a consumer reads it with the reader it bundled at its own release.
Versions differ after every rollout. Before this decision there was one schema, made loose in two
ways that pulled against each other: unknown keys were accepted, but `state` and `agent` were closed
enums, so the first new state from a newer daemon turned the whole snapshot `invalid` for every older
reader; and the eight fields added in 0.94 were optional for the producer too, although it always
writes them. A consumer answered the closed enums by keeping its own copy of the schema with
`.catch('unknown')` — a second description of the same file, drifting with every field.

Control answers are not that kind of data. A client talks to a daemon through the contract it was
built from, and this project keeps one current contract with no installed-client population to
serve (`CLAUDE.md`, «One current control contract»). Optional fields there would be a compatibility
branch by another name.

# Consequences

- A consumer reads the snapshot with the exported read schema and deletes any copy of its own.
- A producer field becomes required in the producer schema the release it is introduced, and
  optional only in the read schema.
- A new value of an enum in a row is added to the producer schema; older readers show it as
  `unknown` until they upgrade.
