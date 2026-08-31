---
title: Isolate release acceptance fixtures from host paths and expired native leases
description: Keep monitoring fixtures on owned workspaces and renew synthetic producer evidence for independent native stream connections.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31
priority: P1
---

## Evidence

The release gate reproduced a timeout in `row and byte limits report omissions`; the focused
suite reproduced it independently. The row-limit loop inherited the session helper's non-existent
home directory. Claude history lookup resolves workspace realpaths, so 256 rows performed 256
lookups through the host home automounter. The same read-only probe measured 5,617 ms for that
missing path, 2 ms for an existing temporary root and 1 ms for the intentional oversized-path
fixture. The host mount inventory confirmed an automounted home root.

After the 5-second test deadline, teardown removed the fixture while its async publication was
still pending; the subsequent chmod ENOENT was secondary. Neither a longer production deadline
nor a swallowed atomic-write error addresses the fixture dependency.

## Scope and acceptance

- [x] Give the row-limit loop the fixture's existing workspace and assert projected rows retain it.
- [x] Keep the byte-limit input, exact omissions, default test timeout and production code unchanged.
- [x] Pass the focused suite repeatedly and the complete local release gate.
- [x] Renew the native stream fixture's producer lease before each independent child connection;
      prove expired evidence still refuses rather than extending production TTL.

This corrective slice belongs to the current release package. No remote configuration,
automounter, provider credential or unrelated session is changed.

## Что сделано

The row-limit fixture explicitly uses `m.stateDir`; an additional assertion checks every projected
row preserves that exact directory. Two independent focused runs passed all 11 tests; the affected
case took 62 ms and 57 ms, respectively. The full gate also passed that case in 53 ms.
The original failed full/focused evidence is retained separately rather than relabelled as success.

The next full gate passed monitoring but refused a resumed native stream with `STREAM_UNAVAILABLE`.
Its synthetic producer wrote once, then three independently started CLI processes shared a five-second
lease across a real heartbeat wait and process startup/termination. The native reader correctly
rejects expiry. A focused run happened to pass in 9.43 seconds overall; this does not erase the full
gate failure. Refreshing the synthetic producer before independent connections models the real
resident writer; an explicit expired-lease assertion keeps fail-closed behavior covered.

The corrected stream fixture passed two focused runs (9.21/9.80 seconds) and the complete suite
(9.02 seconds). Spawned children are registered for unconditional teardown. The repeated full gate
exited 0: 1,006 tests, 5,166 assertions, 170 files, plus packed installation, browser bundle,
Bun/Node execution and both TypeScript resolution checks. No production source or timeout changed.
