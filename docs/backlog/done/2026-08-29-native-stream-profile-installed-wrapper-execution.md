---
title: Native stream profile must execute the standard installed artifact
description: Make the published no-env stream profile runnable against the same installed CCMux entrypoint operators receive.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
priority: high
completed: 2026-08-29 13:57 +0700
depends-on: v0.39.18 control service effect identifier compatibility
---

## Problem

`createCcmuxNativeStreamProfile(installedCcmuxPath)` fixes `env.inherit` to an empty tuple and fixes
argv to `control-native-stream`. The standard installed entrypoint is a wrapper with
`#!/usr/bin/env bash`, so a declared stream using the helper opens and then exits `127` with
`/usr/bin/env: 'bash': No such file or directory`. The profile intentionally carries no `PATH`, and
the helper cannot express the absolute Bun runtime plus bundle path because argv is owner-fixed.

The release acceptance invoked an executable in the source/release environment directly. It did
not activate the exported profile against the standard installed entrypoint under the profile's
actual empty environment.

## Result

- The published helper produces a profile that executes a standard CCMux installation without an
  operator-authored wrapper, PATH injection or copied argv.
- The stream process keeps the intended no-credential/no-caller-env boundary.
- Installation and the profile share one explicit executable contract that survives rollout.

## Plan

- [x] Define the installed executable accepted by `createCcmuxNativeStreamProfile` and make the
      installer publish it atomically with the main bundle.
- [x] Run the generated profile with an empty environment and parse its first owner frame.
- [x] Cover standard install, upgrade and rollback paths rather than only source-checkout execution.
- [x] Publish a patch with exact artifact integrity and installed-profile acceptance; the terminal
      release report records the tag, commit and artifact digest.

## Acceptance

- [x] A profile returned by the public helper and pointed at the documented installed path produces
      a valid initial native frame with `env.inherit: []`.
- [x] The acceptance uses the installed artifact, not `bun run`, a source checkout or inherited PATH.
- [x] Cursor resume and cancellation still pass with the same installed profile.
- [x] No consumer-specific executable shim or environment exception is required.

## Что сделано

- `scripts/install.sh` publishes an atomic POSIX `/bin/sh` entrypoint whose Bun and bundle paths are
  absolute. It therefore runs under the profile's intentionally empty environment without PATH or
  caller credentials.
- `src/config/migrateBundle.ts` converges an older installed shim after ordinary bundle rollout and
  rollback, but only when the daemon owns the default installation data root. Isolated release and
  test runtimes cannot repoint the shared user command; this ownership guard caught and repaired a
  real candidate-test regression before publication.
- `test/native-stream-installed-profile.test.ts` exercises an installed-shaped entrypoint against
  the public profile across initial install, atomic bundle upgrade and `.bak` rollback. The process
  receives an empty environment and returns a schema-valid owner frame.
- The real installed release candidate used the public profile in three managed-session runs. Every
  run parsed the initial frame, resumed the exact cursor with no replayed items and terminated the
  stream cleanly during cancellation. No operator-authored wrapper or environment exception exists.
