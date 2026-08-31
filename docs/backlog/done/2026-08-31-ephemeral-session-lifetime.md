---
title: Control-created sessions outlive their purpose in the fleet map
description: Give short-lived control-created sessions a declared lifetime so the human-facing fleet listing stays a map of real work.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 22:38 +0700
priority: P2
---

## Problem and evidence

Measured on the live fleet at v0.39.38: `ccmux fleet` listed 91 session rows, of which 56 were
short-lived sessions created by control-plane exercises and 55 were `stopped`. The human-facing map
is now about one third real work.

The contract already publishes `archive`, so the capability is not missing — nothing obliges a
creator to use it, and a session that is merely stopped stays in the registry forever. Creation
through the control plane is cheap and scriptable; removal is neither automatic nor implied.

This is a consequence of new capability, not a defect in it. But `fleet` is the primary surface a
person reads to answer "what is running", and a listing that is mostly residue answers that badly.

## Result

- A session created through the control plane can declare that it is short-lived, and the daemon
  retires it without the creator having to remember.
- A retired session leaves no row in the default human listing while remaining inspectable
  explicitly. Provider history is not deleted by retirement.
- Long-lived supervised sessions are unaffected: no lifetime is the default, and nothing
  retires a session a human created.

## Open questions

- Whether the lifetime is a declared TTL, an explicit ephemeral flag, or a creator lease that
  expires when the creating connection goes away. A lease is the most honest but the most work.
- Whether the default listing should also fold away long-stopped sessions independently of this,
  which would help the existing residue without any creator change.

## Что сделано

### Замер опроверг посылку задачи

The task assumed creators of short-lived sessions never retire them. They do: of 23 exercise rows in
the registry, **22 carry `archived: true`**. The `archive` capability was not missing and was not
ignored — it was used correctly, and the residue was never residue.

The defect was in the map. `ccmux list` labelled those rows `archived`; `ccmux fleet` printed the raw
run-state for the same session on the same machine and called it `stopped` — which reads as a live
session that has fallen over and wants restarting. Sixty-one deliberately parked rows presented that
way is what made a 96-row map look like a mess, and no new lifecycle mechanism would have fixed it.

### Реализация
- [x] `src/commands/list.ts` — `rowStateLabel` is now the one definition of a row's state and is
      exported, so the map reaches the same verdict from a peer's JSON.
- [x] `src/commands/fleetList.ts` — the peer contract carries `archived`, and both local and remote
      rows are labelled by that single rule. An older peer omitting it reproduces the previous
      reading exactly rather than guessing.
- [x] Parked rows are counted, not dropped: `… N archived (ccmux fleet --all)`, and `--all` prints
      them. `--json` is never folded — a machine reader asked for the registry and filters itself.
- [x] Measured on the live fleet: the map went from **96 rows to 35**, with 61 counted on three
      lines. No session was removed, archived, or otherwise touched.
- [x] `test/fleet-parked.test.ts` — 6 checks, including an archived session that is somehow running
      (it reports what it is doing, because that is the more truthful signal) and a peer that never
      mentions archiving.
- [x] `docs/architecture/peer-routing.md` records the rule.

### Чего сознательно НЕ сделано
- [x] **No `ephemeral` flag, no TTL, no creator lease.** All three were answers to a problem the
      measurement says does not exist. A TTL promises something about wall time when the question is
      about purpose; a lease tied to a connection would contradict the one thing this supervisor is
      for, which is sessions that outlive their client. Adding a second retirement mechanism beside
      an `archive` that already works would have been the workaround, not the fix.
- [x] Provider history is untouched by any of this — nothing here deletes or retires anything.
