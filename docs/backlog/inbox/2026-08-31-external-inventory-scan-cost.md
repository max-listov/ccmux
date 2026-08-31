---
title: Thread discovery pays a whole-system lsof scan for locks that do not exist
description: Discovery asks lsof about every candidate thread lock, including paths with no file, and that scan dominates an inventory read on a busy host.
type: task
status: inbox
created: 2026-08-31
updated: 2026-08-31
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
