---
title: Thread discovery pays a whole-system lsof scan for locks that do not exist
description: Discovery asks lsof about every candidate thread lock, including paths with no file, and that scan dominates an inventory read on a busy host.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 22:38 +0700
priority: P2
---

## Problem and evidence

Measured on 2026-08-31 with 2000 recorded threads, on a host running about 730 processes:

| Stage | Cost |
| --- | --- |
| Glob over the rollout directory | 7 ms |
| Reading each rollout's first line | 494 ms |
| Process snapshot | ~120 ms |
| **Thread lock inspection** | **4021 ms** |
| Serialising the 1.7 MB answer | 6 ms |

`lsof` costs about 700 ms before it examines any path, because it walks every process's descriptors
first, then a few milliseconds per additional path. Batching by argument bytes rather than by a fixed
count already removed most of the repeated scans (7171 ms → 4021 ms, `src/external/codexLocks.ts`),
so what remains is one scan plus the per-path cost of two thousand paths.

The remaining observation is that most of those paths have **no lock file at all**. Discovery asks
`lsof` about every candidate thread, and `codexThreadLockPath` has already called `existsSync` on
each one, so the answer for the majority is known before the query is made.

## Result

- An inventory read does not pay per-path `lsof` cost for a lock file that does not exist.
- Whatever is skipped is skipped for a stated reason, and the evidence vocabulary still distinguishes
  `observed` from `none-observed` from `unknown` — a cheaper read must not turn "we did not look"
  into "nothing is there".

## The question that has to be answered first

A file that does not exist cannot be opened by anyone, so `none-observed` looks obviously right. It is
not obviously right in one case: a live writer holding a descriptor for a lock that something has
since unlinked. `lsof` can still report that holder; `existsSync` cannot see it. That state is
anomalous, but discovery exists precisely to notice anomalous writers, so skipping the query trades
away exactly the evidence this code was written to collect.

Decide that explicitly before optimising — measure how much is actually saved on a realistic thread
count first, because the fixed 700 ms scan remains either way and may be most of what a normal host
pays.

## Что сделано

- [x] `src/external/codexLocks.ts` queries `lsof` only for lock files that exist and reports
      `none-observed` for the rest, which is the answer a query would have returned for every one of
      them. Discovery over 2000 threads: lock inspection **4021 ms → 3 ms**, whole read
      **6846 ms → 402 ms**.
- [x] The trade is stated where the code makes it and in
      `docs/architecture/external-session-ownership.md`: a live holder of a lock something has since
      unlinked is no longer named. Nothing in the writer protocol produces that state, and
      `none-observed` was already never a claim that a thread is free.
- [x] `test/external-discovery.test.ts` — an absent lock is answered without a system scan (asserted
      by elapsed time, not by reaching into how a subprocess would have been spawned), and a lock
      that does exist is still queried and still canonicalised.

## Что это НЕ решает

- [x] The fixed ~700 ms cost of one `lsof` pass remains for any host that does hold locks. That is
      the price of the evidence and is not worth removing; the measurement above is the argument for
      leaving it.
