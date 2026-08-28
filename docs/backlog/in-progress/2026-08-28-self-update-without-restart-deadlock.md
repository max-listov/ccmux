---
title: Drain daemon self-update without waiting on its own service restart
description: Separate verified bundle installation from restart notification so the healing schedule releases its lifetime before shutdown.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: P1
---

## Evidence and cause

During automatic upgrade to 0.39.14, the previous daemon reported a seven-second forced shutdown:
the healing resource failed to settle. The automatic update awaited `systemctl restart` from
inside that daemon's managed healing run. The service manager waited for the old daemon to exit,
while the daemon drained the run waiting for the service manager. A later ordinary restart of
0.39.14 closed all nine resources cleanly, isolating the defect to the self-update path.

## Plan and acceptance

- [x] Return a verified installation outcome from auto-update without invoking the service manager.
- [x] Request the daemon's normal SIGTERM shutdown only after the healing run can settle;
      retain exit 143 and the existing boot-unit restart policy. Manual CLI updates keep their
      ordinary service-manager restart and verified rollback behavior.
- [x] Prove the actual bundled daemon repairs a missing own bundle, exits with clean resource
      shutdown and starts again with the restored artifact. Stub service-manager commands so a
      regression cannot restart a host service from the test.
- [ ] Run gates, publish the next patch and verify all owned daemons, preserving provider writers.

No provider process, existing thread, registry identity, environment value or network configuration
is changed by this fix. It does not address an external session's missing project directory.

## Что сделано

`src/commands/update.ts` separates automatic verified installation from boot-service restart and
returns whether the daemon must restart. `src/daemon/application.ts` schedules its ordinary SIGTERM
only after the current healing promise can settle. Manual installation/rollback still restart the
boot unit through the previous path; checksum/preflight and atomic predecessor preservation remain.

`test/daemon-update.test.ts` executes the real self-contained daemon, removes only its disposable
test bundle, serves the same verified release, and checks repair, exit 143, clean resource drain,
restored bytes and another successful daemon start. Service-manager executables are deliberately
stubbed, so the test cannot restart host services and an old implementation cannot silently pass.
Focused result: 1 pass, 0 fail, 14 assertions. Full `bun run check`: typecheck and 763 tests pass,
zero failures, 3,524 assertions. `CCMUX_TEST_RELEASE_BUNDLE` can select a downloaded release asset
for the same isolated regression, without modifying an installed runtime. Publication follows.
