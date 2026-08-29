---
title: Drain daemon self-update without waiting on its own service restart
description: Separate verified bundle installation from restart notification so the healing schedule releases its lifetime before shutdown.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28T19:19:12+07:00
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
- [x] Run gates, publish the next patch and verify all owned daemons, preserving provider writers.

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

## Publication and installed verification

- Implementation `dec29a8`; release/tag commit `a41f5fab44e117b149949a7368caf1800a72d1bc`,
  [v0.39.15](https://github.com/max-listov/ccmux/releases/tag/v0.39.15).
  [Tag CI](https://github.com/max-listov/ccmux/actions/runs/33170245231): gate, smoke and release
  all succeeded. Canonical HEAD, remote main, tag and package version agree.
- Published bundle SHA-256:
  `4a476199c8fa8e45fbafc771193453805b023e055dc08dd92ce038f31e919b41`.
  Published control-client SHA-256:
  `4c108925640141ba0e49effa23c2d8451787b3f901758ae852d407f8b58cf105`.
  All three installed bundles match; all published reader checksums were validated.
- Regression against the downloaded 0.39.14 bundle fails: the daemon does not request its normal
  shutdown and the isolated watchdog ends it with 137 instead of 143. The same test against the
  downloaded 0.39.15 asset passes: 1 test, 13 assertions, verified repair, clean exit and restart.
  All removed test bundles were disposable copies, never installed host artifacts.
- Every owned daemon was restarted on 0.39.15 and reported clean shutdown of all nine resources,
  zero failed resources, then ready with no errors from the new daemon PID. Managed identities
  (14 + 14 + 5) and all existing pane PIDs (15 + 14 + 5) remained unchanged across rollout.
- The published resident client passed 100 reads and 33 subscription reconnects on each host.
  The installed external E2E again passed both test-thread working→idle transitions, completion,
  interruption and consumer reconnect, through nine stream frames; both test threads were archived.
- Previous release bytes remain the normal rollback predecessor. No provider launch configuration,
  existing conversation identity, private project directory or consumer application was changed.
