---
title: Observe actual Desktop turns and expose bounded resident delivery
description: Close the gap between a controllable App Server test and observation of existing Desktop threads, without high-frequency inventory scans.
type: task
status: in-progress
created: 2026-08-27
updated: 2026-08-28
priority: high
related:
  - docs/backlog/done/2026-08-27-external-turn-state-independent-of-writer.md
  - docs/research/2026-08-28-codex-control-and-desktop-coexistence.md
  - docs/research/2026-08-28-happy-and-codexmonitor.md
  - docs/backlog/done/2026-08-28-owned-codex-app-server-runtime.md
---

## Problem

With installed 0.39.11, `ccmux external --json` reports an existing Desktop thread as
`state=unknown, evidence=unavailable, source=codex-app-server,
reason=connection-unavailable, observedAt=null, expiresAt=null` while that exact thread is
executing commands. Writer evidence is observed but is not turn evidence. The release's
two-thread E2E used a controllable App Server; it does not demonstrate coverage of existing
Desktop runtime connections. This is an explicit unsupported/unavailable outcome, not grounds
for a consumer to infer working from activity, lock or PID.

A second integration gap: positive observations expire after 5 seconds. Existing consumers
reconcile full inventory on a slower cadence. The architecture explicitly says external inventory
is not a resident observer; repeatedly spawning the full scan to renew a 5-second TTL is not an
acceptable live-state transport.

## Result

- Determine the supported observation route for an already-running Desktop thread. If the
  provider supplies no read-only route, document the exact external prerequisite and retain
  explicit unknown; do not start or take over a runtime to manufacture observability.
- Expose a bounded owner-managed prepared snapshot or subscription for external turn state,
  with identity, source, timestamps, expiry, reconnect and explicit failure outcomes. No
  per-consumer transcript/ownership scans or CLI subprocess on every tick.
- State local/remote coverage explicitly; a local-only source cannot claim fleet-wide coverage.

## Approved scope and ownership

The maintainer approved this root fix and the corresponding downstream integration. This task
owns provider observation, the versioned resident read contract, regression coverage, patch
publication and rollout to owned runtimes. Consumer aggregation and rendering belong to the
consumer, not to this repository. The approved implementation begins with real-runtime access
validation; a missing provider capability must be established before claiming an available API.

Installed 0.39.11 distinguishes two real runtime shapes: one host returns only
`connection-unavailable`; another returns native `working`, `idle` and `not-loaded` observations.
Do not classify the whole provider as unavailable or treat the working host as proof for the
unobservable host. Existing native application tools are an independent verification source,
not a substitute for a CCMux consumer contract.

## Plan

- [x] Inspect the actual Desktop runtime and provider-supported observation interfaces. The
      installed stdio-only runtime has no connectable local status endpoint; exact evidence and
      the missing provider capability are recorded below. This investigation is complete, not
      the Desktop observation acceptance. No second runtime, ownership takeover, internal
      Desktop-process bridge or screen scraping was used.
- [ ] Implement the supported observer in `src/agent/codex/appServer.ts` and
      `src/external/turnState.ts`, retaining explicit unavailable outcomes when unsupported.
- [ ] Publish external inventory and turn observations through a bounded resident interface,
      reusing the existing daemon. Declare discovery, protocol, limits, freshness, cancellation,
      sequence/generation and reconnect behavior. Separate slow inventory from fresh turn state.
- [ ] Make the same contract usable per host over the supported fleet transport, with independent
      host failure outcomes. Document what the consumer must aggregate; no private consumer code.
- [ ] Add regressions and real existing-thread verification for both runtime shapes; measure
      observer/reader costs without transcript rescans or CLI execution per refresh.
- [ ] Update `docs/architecture/external-session-ownership.md` and the resident contract;
      run gates, publish a patch from the canonical checkout and verify every owned runtime.

## State and delivery contract

The provider is the authority for `working`, `idle`, `waiting-approval` and `waiting-input`.
Missing endpoint, omitted thread, disconnect, timeout and expired evidence produce explicit
unknown/unavailable/stale outcomes, never inferred idle. Writer ownership and recent transcript
activity are separate facts. Identity is provider + machine + thread, independent of title.
State transitions and freshness renewal reach resident readers before the declared expiry;
an expired positive observation cannot remain live. Successful empty inventory removes rows;
unavailable inventory retains only explicitly stale last-known data for that host.

If no supported route exists for the actual Desktop runtime, record a reproduced external
blocker and the precise missing provider capability. That is not completed Desktop coverage;
do not close this task by substituting a controllable test runtime.

## Acceptance

- [ ] Real existing Desktop threads under one runtime: concurrent working and idle states agree
      with independent native observation, then completion/interruption/approval transitions.
- [ ] Endpoint absent, deadline and disconnect expire positive state and never report false idle.
- [ ] Resident consumer can stay fresh within 5-second TTL without running full inventory scans.
- [ ] Document versioned contract and release evidence; preserve all user threads and sessions.
- [ ] A consumer using only the published CCMux contract observes the same exact existing thread
      identities and transitions on a local and remote host. One unavailable host cannot erase
      healthy-host observations; no native application tool is used as the delivery channel.
- [ ] Record release/tag, artifact hashes and post-rollout runtime parity; a controlled test
      runtime alone cannot satisfy existing-Desktop acceptance.

Priority: high. This blocks truthful live activity in downstream fleet interfaces.

## Reproduced external prerequisite

Validation: 2026-08-28. CCMux 0.39.11; installed provider `codex-cli 0.150.0-alpha.8`.
The matching upstream tag `rust-v0.150.0-alpha.8` resolves to source commit
`fcbdb57851be70192fd0c21faa9e529146e93ff1`.

- The actual Desktop-owned provider process uses `app-server` without `--listen`; its default
  is `stdio://`. Process inspection finds neither a listening TCP endpoint nor a named Unix
  control socket for that process. The configured control-socket directory is absent.
- The provider's own read-only `codex app-server daemon version` fails with missing control
  socket (`os error 2`). Direct `connectCodexAppServer(loadMachineConfig())` fails with
  `Codex App Server control socket is unavailable` (probe exit 3).
- Installed `ccmux external --json` finds the currently executing thread by exact UUID but
  returns `unknown/unavailable/connection-unavailable`, with null observation timestamps.
  A separate existing Unix-socket runtime is a positive control: the same installed CCMux
  reports native working and idle states there. It is not proof for the stdio-only runtime.
- Upstream `codex-rs/app-server/src/lib.rs` selects one local transport in its startup match:
  `Stdio` calls `start_stdio_connection`; `UnixSocket` calls `start_control_socket_acceptor`.
  It explicitly marks stdio as `single_client_mode`. The runtime status manager in
  `codex-rs/app-server/src/thread_status.rs` keeps runtime facts in an in-process map.
  Stored inventory is not a replacement for access to those live facts.
- Provider docs describe Unix-socket clients and read-only `thread/list`/`thread/read` on the
  selected transport. They do not establish an additional client attachment route for this
  existing stdio-only Desktop process. `daemon start` would start a different runtime, not
  expose this process; it was not invoked. Remote-control enrollment is not a local read-only
  socket repair and was not enabled.

References: [App Server protocol](https://learn.chatgpt.com/docs/app-server),
[upstream transport selection](https://github.com/openai/codex/blob/fcbdb57851be70192fd0c21faa9e529146e93ff1/codex-rs/app-server/src/lib.rs#L728),
[runtime status authority](https://github.com/openai/codex/blob/fcbdb57851be70192fd0c21faa9e529146e93ff1/codex-rs/app-server/src/thread_status.rs#L310).

The missing capability is a provider-supported connection to the same Desktop-owned runtime,
or an explicit provider-supported Desktop launch mode exposing that runtime to external readers.
The current mandate includes investigating an identity-preserving shared-runtime launch and
implementing the complete observation path when that route is validated. It does not authorize
bypassing application peer authorization or treating a replacement test runtime as existing-thread
coverage. A CCMux-only wrapper cannot create native evidence. Explicit configuration restrictions
still apply to environment values, endpoint URLs and ports.

Existing focused gate: `bun test test/external-turn-state.test.ts` — 11 pass, 0 fail,
245 assertions. These tests validate mapping, bounds, disconnect handling and the control-socket
transport; they do not satisfy the real stdio-Desktop acceptance. Resident API implementation,
full gates, publication and rollout remain unperformed. No release is claimed for this task.

## Existing Desktop access validation

Validation: 2026-08-28, provider `0.150.0-alpha.8`. The requested result remains automatic
observation of the existing Desktop threads, not a manually populated activity snapshot.

- The bundled `codex-app-tools` MCP server initializes from a separate process, but its
  `tools/list` request fails with `Codex app tools pipe closed`. The Desktop log identifies
  the cause explicitly: `dynamic_app_tools_peer_rejected
  reason=untrusted-code-signing-identity`. This is a peer-authorization refusal, not a JSON-RPC
  framing error. Do not bypass the check, impersonate a trusted client, patch the application,
  or try other internal channels to evade this boundary.
- The application-native task listing remains an independent observation available inside the
  application. It does not establish that the CCMux daemon can make that request autonomously.
  One fleet listing took approximately 184 seconds and returned remote threads as `notLoaded`
  without an unavailable-host entry. A consumer must not equate that result with confirmed
  execution termination or let one remote query block local freshness.
- Read-only inspection of `thread_history_1.sqlite` found persisted `inProgress` rows whose
  turn IDs precede the current live turns. A successful SQLite read does not prove projection
  freshness. No state is inferred from these rows.
- Upstream `codex-rs/rollout/src/policy.rs` persists `TurnStarted`, `TurnComplete` and
  `TurnAborted`, but excludes `ExecApprovalRequest`, `RequestPermissions`, `RequestUserInput`
  and `ElicitationRequest`. This history cannot reproduce all native active flags. Bounded
  tail probes also lacked turn-boundary events for several actively running threads; absence
  in a bounded tail is not evidence of idle.
- Documented user hooks expose prompt submission, stop and permission events, but no verified
  initial live snapshot of already-running threads. They are not accepted as complete coverage
  of interruption, crash and waiting-input transitions without further proof.
- The documented Remote setup connects a separately approved controller device. The standalone
  `remote-control` CLI starts or connects to a daemon; it does not attach a status listener to
  the existing stdio-only process. Neither enrollment nor a replacement runtime was started.

Remaining external prerequisite: a provider-authorized observer/export for this existing Desktop
runtime, or a documented shared-runtime connection mode with a verified identity-preserving
transition. No automatic Desktop-to-CCMux delivery or consumer integration is demonstrated by
these probes. The implementation and release acceptance above remain open.

## Shared-runtime design and launch prerequisites

The proposed architecture has one provider runtime per host, with Desktop as the interactive
client and the existing CCMux daemon as an observing client. CCMux combines an initial native
snapshot with status notifications and bounded reconciliation, then serves a prepared projection
to resident consumers. The observer must not resume, adopt or create threads to make them visible.

Implementation order:

1. Validate a provider-supported Desktop connection to the shared runtime, retaining the same
   thread identities, authentication, native application tools, Code Mode and approval behavior.
   A process migration cannot preserve an in-flight turn merely by preserving its thread UUID;
   quiescence and an explicit recovery procedure are prerequisites to a live cutover.
2. Maintain one bounded observer connection per host. Register notification handling before
   snapshot reconciliation; prevent an older snapshot from overwriting newer events. Refresh
   source evidence independently of the slow inventory scan. Reconnect invalidates the old
   connection generation before rebuilding the projection.
3. Publish provider + host + thread identity, native state, source availability, observation
   time and expiry through the existing resident-reader architecture. Consumer count must not
   multiply provider connections, transcript reads or CLI processes.
4. Render working, idle, waiting-approval and waiting-input separately from connection health.
   A lost host retains explicitly stale last-known rows and must not change healthy-host state.
   An exact working count includes only fresh working observations; recent activity is a
   separate inventory filter, never evidence that a turn is running.
5. Verify real existing-thread transitions, host disconnect/recovery, expiry and restart on
   local and remote runtimes before publication and rollout. Independent Desktop observation
   is a verification oracle, not the production delivery mechanism.

Installed application configuration evidence, checked on 2026-08-28:

- A local daemon transport branch exists behind `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`. It is
  also conditional on **no startup config overrides**, no forced CLI/custom CLI selection,
  and a compatible existing daemon. Enabling the flag alone does not establish this branch.
- The local stdio path builds startup overrides for the bundled application-tools MCP server
  when its private tools pipe and plugin manifest are available. Those overrides select the
  stdio fallback instead of the daemon branch. Disabling native tools merely to satisfy this
  guard is not an accepted migration.
- A separate transport selector reads `CODEX_APP_SERVER_WS_URL` or the host's `websocket_url`.
  That branch does not execute the stdio startup-override builder. Its presence in installed
  code is not proof of a documented, capability-preserving Desktop deployment contract.
  Non-loopback routing also has application-specific proxy behavior; arbitrary socket URL
  substitution is not established by this inspection.
- The standalone CLI and the bundled provider have different installed versions. The upstream
  daemon bootstrap selects its managed CLI installation; invoking it is not proof that the
  Desktop's bundled version and startup features will be retained.

These are candidate launch mechanisms, not a successful cutover. No environment values, endpoint
URLs, ports, application bundle or runtime configuration were changed. No live turns were
interrupted. A shared-runtime migration and the resident observation implementation remain
unverified; the task is not ready for release.

## Authorized isolated visibility experiment

The maintainer requested one new test conversation in the canonical project and a separate
shared App Server, without migrating existing Desktop conversations. The experiment compares
the exact test thread identity and live status through CCMux and the native Desktop reader.
Discoverable persisted history alone does not satisfy simultaneous live visibility. Use a
local Unix socket, do not change Desktop launch settings, and do not resume the test thread
through a second runtime while its first writer is loaded. Record both positive and negative
results before deciding whether a Desktop connection change is necessary.

### Experiment evidence

Validation: 2026-08-28, bundled provider 0.150.0-alpha.8, one newly created read-only test thread.
The shared server uses the default local Unix control socket and a dedicated terminal-multiplexer
session; the Desktop launch configuration and all existing conversation writers are unchanged.
The new conversation is pinned in Desktop. Its provider runtime was restarted and the same UUID
resumed successfully; the first and second test turns completed with their expected reply markers.

The test reproduced two owner defects and includes their local fixes:

- `src/external/turnState.ts`: the initialize version parser rejected the installed prerelease
  suffix before issuing any status request. Newer prereleases now pass the bounded-list floor;
  older versions, floor prereleases and malformed suffixes remain rejected. Regression coverage:
  `test/external-turn-state.test.ts`.
- `src/external/codex.ts`: the shared tmux server retained another pane's `_run` launch arguments,
  causing the test writer to be incorrectly classified as managed and omitted from external
  inventory. Ancestry classification stops at the multiplexer boundary, retains genuine pane-local
  supervisor detection and distinguishes the bundled binary from the Desktop host executable.
  Regression coverage: `test/external-discovery.test.ts`.

The canonical source CLI found the exact test identity with native `idle` at
2026-08-28T02:38:43.176Z and native `working` at 2026-08-28T02:39:17.272Z, with five-second expiry.
During that working turn the native Desktop reader returned the same UUID as `notLoaded` and
presented the unfinished persisted turn as `interrupted`. The shared provider reported it as
active. This establishes inventory/history visibility in Desktop, **not** shared live control.
The installed 0.39.11 binary still contains both owner defects; source validation is not an
installed-release claim. The test does not satisfy the existing Desktop observation acceptance.

Final local gate: `bun run check` — typecheck and 717 tests pass, zero failures, 2,847 assertions.
The final test turn completed with its expected reply marker; the native provider reported idle
at 2026-08-28T02:42:05.254Z. The test server remains running, its conversation is retained and
pinned, and existing Desktop sessions were not migrated or interrupted. No simultaneous live
Desktop connection, consumer rollout or release is claimed. This experiment confirms that a
separate server plus a visible conversation does not automatically connect Desktop to its writer.

### Desktop attachment validation

The target is the official ChatGPT Desktop application, not a replacement client. The requested
end state is one provider thread with one runtime, controllable through CCMux and simultaneously
visible as live in Desktop. T3 Code's ownership of its own App Server and UI does not establish
that the official Desktop can attach to an independently launched runtime.

Read-only revalidation on 2026-08-28 establishes:

- The installed bundled provider remains `0.150.0-alpha.8`. The current Desktop child uses stdio
  and includes both the Code Mode feature and a native application-tools startup override. Its
  process has no listening TCP endpoint or named Unix control socket.
- The independent test daemon answers the provider's `daemon version` command successfully.
  This positive connection check does not identify it as Desktop's runtime. At
  2026-08-28T03:10:19.370Z it returned `notLoaded` for the exact currently executing Desktop
  thread; the immediately following native Desktop read returned `active` for that identity.
- The retained test conversation is currently `notLoaded` in both readers, with its final probe
  recorded as completed. That agreement is not a simultaneous-live positive control.
- The local-daemon transport guard requires an empty startup-override list. The native tools
  override makes that condition false in this installation. Bundled Git is absent, so it is not
  the failing condition here. Toggling the daemon flag alone cannot connect this configuration.
- The direct WebSocket selector exists, but bypasses the startup-override builder. No test has
  established preservation of native tools, approvals and Code Mode through that branch. It is
  an experimental launch candidate, not a demonstrated supported Desktop configuration.
- The documented SSH host route is a distinct supported Desktop entry point. Installed code
  starts/connects the remote daemon and uses `app-server proxy`. The local machine has no
  configured self-SSH alias and a bounded TCP connection probe to loopback port 22 fails. Adding
  SSH service/network configuration is not a read-only attachment to the existing local runtime.

References: [Desktop SSH connections](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host),
[App Server transports](https://learn.chatgpt.com/docs/app-server).

No existing writer was resumed, migrated or interrupted. No application bundle, environment,
endpoint URL, port, authentication policy or Git index was changed. The next decisive experiment
requires an explicitly selected Desktop connection configuration and an isolated capability test;
do not silently switch the main application's local backend or disable native tools. Existing
Desktop coverage and release acceptance remain open.

## Validated runtime options

The [runtime coexistence research](../../research/2026-08-28-codex-control-and-desktop-coexistence.md)
records official terminal-client attachment to the existing test server, bidirectional CLI/RPC
turns, 100 metadata reads and client reconnect with unchanged identity. Native Desktop still
reports that actively executing test thread as `notLoaded`; history visibility is not live
attachment. Existing remote Desktop threads do return native working and idle through installed
CCMux, so available-host observation must not be conflated with the local attachment prerequisite.
The research separates immediate resident observation, an opt-in owned App Server driver and
official Desktop qualification. It does not close any unperformed acceptance or claim a release.
