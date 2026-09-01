---
title: Codex runtime control and official Desktop coexistence
description: Tested runtime boundaries, provider-native control options and the distinction between shared history and shared live sessions.
type: research
status: active
created: 2026-08-28
updated: 2026-08-28
related:
  - docs/backlog/done/2026-08-27-desktop-turn-observation-and-resident-delivery.md
  - docs/research/2026-07-30-the external reference harness-analysis-ideas.md
---

# Decision summary

Creating a conversation in a terminal is not the requirement. The requirement is that every
controller and observer talks to the **same provider runtime**, with one writer for each thread.
Shared history files, a shared account and matching thread UUIDs do not establish shared runtime
state. An application can list a conversation while remaining disconnected from its live writer.

The recommended direction is a provider-native control plane in CCMux, with separate capabilities
for owned runtimes and externally observed runtimes. Keep the official Desktop workflow where its
existing runtime is connectable. Qualify official Desktop attachment separately; do not migrate
all conversations to terminal sessions or promise that another App Server will automatically
appear as live in Desktop.

This is research and a controlled experiment, not a completed implementation or release. The
existing project vision still requires an explicit architectural decision before replacing the
managed Codex TUI driver with an owned App Server driver.

## Evidence levels

- **Executed:** native application reads, installed CCMux inventory on two hosts, a controlled
  shared App Server, official CLI attachment, bidirectional prompts, status reads and reconnect.
- **Source inspected:** the installed provider's matching upstream version and the external reference harness.
- **Documentation inspected only:** Happy, CodexMonitor, Claude Remote Control and authentication
  guidance. Those products were not installed or runtime-tested in this investigation.
- **Not demonstrated:** simultaneous live attachment of the official local Desktop to the
  separately launched test runtime; full approval/input/cancellation parity; resident consumer
  delivery; rollout. No existing working conversation was adopted, resumed or interrupted.

## Real experiment

Validation date: 2026-08-28. CCMux checkout/package: `0.39.11`, commit
`39ae820cabced25f6562d998ee33a88bfac3c3c2`, with the existing unreleased discovery/version fixes.
The installed binary does not include those fixes. Provider: `0.150.0-alpha.8`, matching source
`fcbdb57851be70192fd0c21faa9e529146e93ff1`.

One retained, non-production test conversation was used throughout. Its server was already
running on the local Unix control socket. No application launch settings, environment values,
endpoint URLs, ports or authentication settings were changed.

An official terminal client joined that runtime with:

```sh
codex resume --remote unix:// --no-alt-screen -s read-only -a never <test-thread-id>
```

The second client used the existing CCMux exports in `src/agent/codex/appServer.ts`:
`connectCodexAppServer`, `readCodexAppThread` and `startCodexAppTurn`.
`account/read` reported ChatGPT subscription authentication. No credential values were printed.
All test prompts prohibited file edits and requested only a bounded `sleep` plus a reply marker.

| Probe | Result |
| --- | --- |
| RPC client sends; official terminal receives | Passed. The terminal displayed the prompt and `CCMUX_RPC_TO_CLI_OK`. Native `active` was observed at `05:46:51.041Z`, then `idle` at `05:47:14.251Z`. |
| Terminal sends; RPC client reads | Passed. The same thread received `CCMUX_CLI_TO_RPC_OK`; native working was observed at `05:48:19.359Z`, then idle at `05:48:33.476Z`. |
| RPC client disconnects and reconnects during a turn | Passed. The identical thread was still active at `05:49:07.659Z`; the turn completed with `CCMUX_RECONNECT_OK`. |
| Canonical source `external --json` reads the test | Passed. Exactly one matching row, native working at `05:49:25.597Z`, five-second expiry. This is a source-path result, not an installed-release result. |
| Official Desktop reads that same active test | Live coexistence failed. It returned `notLoaded`, and represented the currently unfinished turn as `interrupted`, while the shared runtime continued executing it successfully. It could read completed history. |
| Terminal disconnects after completion | Passed. The test client exited with code zero; another RPC read still found the same thread idle at `05:51:03.634Z`. |

The runtime restart/resume experiment recorded in the related task also retained this test
identity. The current experiment adds a genuine second interactive client and bidirectional
input; reconnecting a client is not described as restarting the provider process.

### Small read-cost measurement

One established RPC connection performed 100 metadata-only `thread/read` calls: 50 sequential,
then 50 in five batches of ten concurrent requests. All returned the expected identity.

| Measurement | Result |
| --- | --- |
| Sequential median / maximum | 2.85 ms / 7.17 ms |
| Concurrent per-request median / maximum | 17.09 ms / 34.70 ms |
| Wall time for the 50 concurrent calls | 144.73 ms |

The client launched no CLI per read. This measures warm local RPC latency, not full fleet cost,
CPU, a 15-minute cache window or the absence of provider-internal storage reads. Upstream
`read_thread_view` combines persisted metadata with live runtime state. A resident status
implementation must separately validate its bounded snapshot/event path.

The terminal reported `hook returned invalid stop hook JSON output` after completed turns.
All three provider turns completed with their expected markers, but this warning prevents a
claim of a clean end-to-end hook configuration. It was not suppressed or changed for the test.

## Existing Desktop sessions: two different runtime shapes

On one existing SSH host, installed CCMux returned two genuinely working Desktop threads and
one idle thread in the same native snapshot at `05:49:56.794Z`. An independent native Desktop
read agreed that a selected working thread was active. One working thread had old transcript
activity: an activity-age filter alone would wrongly exclude it.

On the local host, the actual Desktop runtime uses a private stdio connection. The independently
launched test server is a different runtime even though both can read the same stored UUIDs.
Installed CCMux additionally rejects the test provider's prerelease version as
`unsupported-runtime`; the source fix removes that rejection, not the underlying Desktop
attachment boundary. Neither a recent file write nor a live process substitutes for turn state.

The current external command is local-only. A fleet consumer must obtain an independent source
for each host. A 30-second reconciliation interval cannot by itself keep five-second evidence
fresh. Session/chat feed events are not a replacement for a native external-status feed.

## How the external reference harness does it

Inspected revision: `2fbe313096b54a3422e101ed1bcc3589f6cf371c`.

the reference harness owns both its application interface and its backend. Its Codex adapter spawns an App Server
child, communicates over stdio, starts/resumes a provider thread, and maps native turn events
into its own session state. Its UI consumes its orchestration protocol; it does not depend on
the official Desktop discovering its processes. Claude uses the Agent SDK adapter instead.

Useful patterns are separate provider adapters, request/notification handling, explicit
approval and input requests, persisted provider resume identity, and snapshot plus sequenced
events for UI reconnects. The choice of stdio is compatible with multiple UI clients because
the the reference harness backend is the single provider client and fans out its own state.

One pattern must **not** be copied into identity-pinned CCMux delivery: the reference harness can fall back from a
recoverable `thread/resume` error to `thread/start`. CCMux must report a failed resume rather than
silently changing the conversation receiving a message. The earlier ideas document is not
authorization to weaken that invariant.

Sources: provider architecture,
Codex runtime,
Claude adapter.

## Available paths

| Path | Benefit | Boundary |
| --- | --- | --- |
| Keep official Desktop; observe its existing connectable runtimes | Preserves the familiar interface; remote native status is already proven. | Read access does not confer lifecycle ownership. The local stdio runtime remains unobservable externally. |
| CCMux-owned App Server; CCMux/custom UI and terminal clients | Native turn state, typed control and a stable owner-managed process boundary. CLI plus RPC coexistence is proven. | A new owned driver and lifecycle contract are still required. Official Desktop live attachment is not automatic. |
| Official Desktop SSH-host workflow | Documented Desktop route to a remote runtime; the tested existing host exposes native state. | Qualify startup ownership, native tools, approvals and recovery before claiming CCMux owns that runtime. |
| Experimental local Desktop external-server selector | Candidate for retaining official local Desktop and a shared writer. | Installed code exposes selectors, but the capability-preserving route has not passed testing. Do not switch the main app or disable its tools to force it. |
| the external reference harness / Happy / CodexMonitor as the interface | Existing alternative clients instead of building an entire UI immediately. | They are their own clients, not demonstrated bridges into the official Desktop's current live sessions. |

[Happy](https://github.com/slopus/happy) provides its own CLI wrapper and web/mobile/desktop
clients; its README describes restarting a session into remote mode when changing control.
[CodexMonitor](https://github.com/Dimillian/CodexMonitor) runs App Servers per workspace and has
an optional remote backend. Its README explicitly distinguishes discoverable CLI history from
live streaming. Neither README establishes safe simultaneous attachment to an unrelated writer.

The provider documents Unix control sockets and the official CLI's remote client. Its raw TCP
WebSocket transport is labeled experimental/unsupported; a public unauthenticated listener is
not the recommended fleet boundary. Use the existing authenticated host transport and a local
provider connection. See [App Server](https://learn.chatgpt.com/docs/app-server) and
[Desktop SSH connections](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host).

## Subscription and Claude are separate questions

The executed Codex tests used native ChatGPT sign-in, not a custom model API proxy. OpenAI
documents subscription and API-key authentication as different billing paths:
[Codex authentication](https://learn.chatgpt.com/docs/auth).

Claude is not limited to terminal scraping. Its documented
[Remote Control](https://code.claude.com/docs/en/remote-control) connects a running local CLI
session to official web/mobile clients, with messages from either surface. This is not proof
of simultaneous Claude Desktop attachment. the reference harness's SDK-based Claude path is another option.

Do not assume that an SDK automatically requires API billing. The current
[subscription notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
explicitly pauses the announced separate SDK credit change; it says SDK and `claude -p` usage
still draws from subscription limits. Authentication must remain provider-native and personal;
this is not permission to collect or proxy other users' subscription credentials. See the
[provider's credential rules](https://code.claude.com/docs/en/legal-and-compliance).
No Claude SDK or Remote Control runtime test was performed here.

## Recommended implementation sequence

1. **Observation first.** Add a bounded resident observer to the existing CCMux daemon for
   each connectable runtime. Keep native state separate from inventory, writer ownership and
   host health. Do not resume a thread just to observe it.
2. **Deliver the facts already available.** Publish independent host snapshots/events with
   identity, native title, observed time, expiry and connection generation. Consumers merge
   hosts and render explicit unsupported, disconnected and stale reasons. Fresh working/waiting
   threads survive a recent-history filter; unknown is neither zero working nor confirmed idle.
3. **Owned runtime pilot.** Implement a Codex App Server driver for opt-in test sessions under
   CCMux. Preserve the native provider, authentication, exact resume UUID and approvals. The
   invariant is one writer per thread, not necessarily one server process for an entire fleet.
   Keep the existing interactive Claude path unless a separate SDK migration is chosen.
4. **Qualify the official Desktop client.** Test supported SSH/shared-runtime attachment on
   an isolated conversation, including native app tools, Code Mode, draft input, approvals,
   interrupt, crash/recovery and restart/resume. A shared history screenshot is not acceptance.
5. **Migrate only validated paths.** Quiesce a conversation before moving its writer; persisting
   the UUID does not preserve an in-flight turn. If official Desktop cannot be retained on a
   given runtime, keep observation-only support there and make the custom-UI tradeoff explicit.

The expected state machine is unloaded → idle → working → idle, with explicit waiting-approval,
waiting-input and error branches. Transport loss or expiry changes evidence to unavailable/stale;
it does not invent a provider transition. Lifecycle control of an owned process and read-only
observation of somebody else's process must remain separate capabilities.
