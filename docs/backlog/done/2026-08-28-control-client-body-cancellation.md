---
title: Adopt response-body cancellation in the configured control client
description: Use the fixed Stitchkit HTTP adapter for resident streams and prove server-side release and connection reuse.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 18:30 +0700
related:
  - docs/backlog/done/2026-08-28-stitchkit-control-plane-and-daemon-lifecycle.md
---

## Problem

The configured HTTP adapter in Stitchkit 0.68.3 drops caller cancellation after response
headers. The existing control client avoids that affected construction by using the supported
Fetch-config client for subscriptions. Stitchkit 0.68.5 fixes the underlying adapter; the
control client can use the configured HTTP interface consistently without a cancellation shim.

## Result and scope

Adopt the published dependency and configured streaming adapter in the canonical source tree.
Keep unary response limits separate from streaming lifetime and retain all existing identity,
authorization, freshness and session-ownership boundaries. This is a local dependency integration
and verification slice; it does not claim a new CCMux publication or Desktop observation coverage.

## State and actions

Opening a subscription establishes a bounded header deadline. After headers, only caller/body
ownership controls its lifetime. Abort or iterator return must release the server reader and
physical Unix connection; a new subscription must reuse capacity without closing the client.

## Plan

- [x] Verify the owner release and pin its exact published dependency version.
- [x] Use configured HTTP clients for both contracts, retaining separate bounded Unix transports.
- [x] Prove post-header cancellation, unread iterator return, quiet pending reads and slot reuse
      against a real control listener and the self-contained client asset.
- [x] Run focused and full gates and update the control architecture reference.

## Acceptance

- [x] Cancellation frees the server subscription before client or server shutdown, and more than
      the connection capacity worth of sequential subscriptions succeeds on the same client.
- [x] A quiet stream survives its header deadline and remains cancellable after that deadline.
- [x] Full checks and offline bundle tests pass without a new provider session or installed-runtime change.

## Что сделано

- [x] Dependency: `package.json` and `bun.lock` pin published `stitchkit@0.68.5`.
      Registry integrity matches the owner's release record:
      `sha512-9OXV5we+TeSMdHXKtpuJvBNB0QONm+IRJsibhj/uH1w1T/0selespylsMAVpIlI92eW5e26FqthLJu5GPWAlDQ==`.
      The canonical source and completed owner task confirm cancellation remains composed
      after response headers; no owner source changes were needed.
- [x] Client: `src/control/client.ts` uses configured HTTP adapters for both unary and stream
      contracts, with retries disabled and separate finite/streaming Unix transport bounds.
      No cancellation wrapper, protocol change or session mutation was added.
- [x] Regression: `test/control.test.ts` first reproduced two failures with the configured
      adapter on 0.68.3: caller abort after headers and return before the first item left a
      server reader registered. On 0.68.5, all three release modes pass 33 consecutive
      subscriptions each on one client with a 32-connection limit. Server reader count reaches
      zero before client shutdown. A separate quiet-read test survives its 100 ms header
      deadline, then cancels the pending read and reopens the same client successfully.
- [x] Artifact: `test/control-client-bundle.test.ts` exercises 100 reads and 33 subscription
      reopenings through the self-contained ESM asset, including pending-read cancellation.
      Package installation is disabled, the package cache is empty and the registry is unreachable;
      reader subprocess and server creation are prohibited. Discovery requires no provider binary.
- [x] Validation: focused control/client/daemon tests pass (15 tests, 362 assertions).
      Full `bun --no-env-file run check` passes typecheck and 753 tests across 113 files,
      zero failures, 3,377 assertions. `git diff --check` passes.
- [x] Live compatibility: the updated source client completed 100 concurrent reads and
      33 subscription reconnects against an installed 0.39.13 daemon; all snapshots remained
      live and reader subprocess creation was prohibited. All three installed bundles still
      match published 0.39.13 SHA-256
      `f052a83615e8cb58173f4c5174b6906b531498038f68865ca2c57a86250e859b`.
- [x] Documentation: `docs/architecture/control-plane.md` records the current adapter and
      body-lifetime ownership; `CHANGELOG.md` records the integration under Unreleased.
      No new CCMux publication, installed-runtime update or Desktop coverage is claimed.
