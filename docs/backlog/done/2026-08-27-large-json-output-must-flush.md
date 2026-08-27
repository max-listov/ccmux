---
title: Large JSON output must flush before CLI exit
description: A valid external inventory becomes truncated when stdout is a pipeline because the CLI exits before buffered output is flushed.
type: task
status: done
created: 2026-08-27
updated: 2026-08-27
completed: 2026-08-27 07:47 +0700
related: docs/backlog/done/2026-08-27-external-threads-are-addressable-but-not-listable.md
---

## Why

`ccmux external --json` can exceed a pipe's buffer. The command builds valid JSON, but the CLI uses
`process.exit()` immediately after dispatch. When the consumer is a pipeline, buffered stdout is
discarded and the reader receives an unfinished JSON string. A direct file redirect can hide the
defect because it drains faster.

## Result

- Every command is allowed to flush stdout and stderr before the process exits.
- A real CLI regression covers an external inventory larger than the pipe buffer.

## Plan

- [x] Reproduce truncation through a real piped CLI process.
- [x] Replace forced successful dispatch exit with normal event-loop completion while preserving
      the command's exit code.
- [x] Prove large JSON parses in the focused test and through the installed command.

## Acceptance

- [x] Large `ccmux external --json` output remains complete through a pipe.
- [x] Non-zero command exits remain non-zero.
- [x] Full project gates pass before the superseding patch release.

## What was done

- [x] Runtime: `src/cli.ts` leaves normal stream draining to the event loop while preserving the
      dispatched exit code.
- [x] Output: `src/commands/external.ts` awaits the stdout stream callback for the complete JSON
      payload instead of treating a queued console write as delivery.
- [x] Regression: `test/external-command.test.ts` builds the shipped bundle, pipes a 2,000-row
      inventory larger than one MiB, parses every row and verifies a bad option still exits 1.
- [x] Installed path: the staged bundle completed five consecutive real inventory pipelines with
      valid JSON; daemon health remained active.
- [x] Gates: TypeScript and all 681 tests pass with 1,834 expectations.
