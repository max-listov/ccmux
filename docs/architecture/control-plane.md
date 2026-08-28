---
title: Local resident session control
description: Typed same-user IPC, bounded live snapshots and managed daemon lifecycle without a second provider writer.
type: architecture
status: active
created: 2026-08-28
updated: 2026-08-28
---

# Ownership

CCMux owns session identity, the durable chat journal, delivery receipts, native provider adapters
and supervisor restart policy. Stitchkit owns the typed request contract, HTTP/CLI/tool execution,
bounded Unix transport, stream framing, operation admission and process-local resource ordering.
It does not replace the Codex/Claude inference loop, authentication or conversation history.

```
native session supervisors → existing daemon observation pass → prepared snapshot
                                                               ├─ HTTP client
same durable chat + native turn operations ← control contract ← ├─ CLI/tool proxy
                                                               └─ resident stream
```

Only registered managed sessions are in this surface. Desktop-owned threads are not imported,
adopted, restarted or counted as managed sessions. The external inventory and its independent
observation prerequisites remain separate. No TCP listener or fleet-routing replacement is added.

# Connection and identity

The daemon binds `control/api.sock` under the configured state root. Its directory is owned by
the daemon user with mode 0700, the socket with mode 0600. A live listener, foreign/permissive
directory, symlink or regular-file collision is refused; only a stale owned socket is reclaimed.
The OS user is trusted. This is not isolation against another process running as that same user.
Browser Origin requests are refused. Forwarded identity headers have no authority by themselves.

Without a managed claim the authenticated local user acts as `cli`. To preserve managed sender
identity, pass both `session` and its inherited `CCMUX_CHAT_CREDENTIAL`. The daemon checks the
registered session, chat enablement and current capability; rotation invalidates an old client.
Provider account credentials are neither copied nor returned. Every target includes
`kind=managed`, `source=ccmux`, `machine`, `agent`, `session` and exact `threadId`. Commands refuse
replacement UUIDs, providers and machine identities, even if the name matches.

`createControlClient()` discovers the configured socket using CCMux's shared configuration
selection and location rules. Discovery needs no provider binary. An explicit local `socket`
option selects another isolated instance; it is deployment configuration, never a request-body
path to make the daemon read. A client captures its location at construction. After root/identity
configuration changes, the existing socket refuses commands and publishes `config-changed`;
restart the daemon and construct a new client to bind/discover the new socket. The existing file
monitoring publisher continues to follow live configuration independently.

# Contract

`src/control/contract.ts` is the single schema-derived HTTP/CLI/tool declaration. HTTP paths have
no implicit `/api` prefix. The CLI is `ccmux control <command>`; `--help` renders contract inputs.
Object-valued flags such as `--target` accept JSON; `--json` selects compact output.

| Client method / CLI | HTTP | Result |
| --- | --- | --- |
| `list` / `sessions` | GET `/control/sessions` | Prepared complete bounded snapshot |
| `get` / `session` | POST `/control/session` | One exact registered identity |
| `message` | POST `/control/message` | Durable acceptance and duplicate flag |
| `start` | POST `/control/start` | Start existing non-archived identity; no duplicate writer |
| `interrupt` | POST `/control/interrupt` | Interrupt the exact working native turn |
| `wait` | POST `/control/wait` | Between-turn outcome, timeout or unavailable |
| `watch` | GET `/control-events/` | Absolute snapshots over typed NDJSON |

New session creation remains `ccmux new`; this API cannot change directories, launch flags,
provider settings or credentials. `message` requires a caller-generated immutable UUID. Retrying
the same sender/target/body/defer/notBefore/task with that UUID returns `duplicate: true`.
Reusing it for different content or identity is `IDEMPOTENCY_CONFLICT`. Acceptance means stored,
not delivered or completed. Existing delivery gates hold messages during busy turns, approvals,
input requests, partial composers and ambiguous native pickup. The API never types into those UI
states. `interrupt` requires both the exact session identity and current native turn ID, rechecks
provider state and never answers an approval or input request.

`wait` is native-runtime-only and requires an observation made after the call began. It checks
the delivery cursor and unresolved pickup as well as idle/terminal state: reading inbox does not
cancel a queued delivery. Outcomes distinguish `idle`, `completed`, `interrupted`, `failed`,
`timeout` and `unavailable`. They do not assert that a business task is complete. Client cancellation
only cancels that wait. Deadlines never acknowledge a message or declare a running operation done.

# Resident consumption

Import `ccmux/control-client` in Bun, or download the release's immutable `control-client.js`
and verify `control-client.sha256`. The ESM asset bundles its dependencies and starts no runtime
on import. The command-line bundle also remains self-contained/offline.

```ts
import { createControlClient, currentControlSnapshot } from "ccmux/control-client";

const client = createControlClient();
const stop = new AbortController();
try {
  const stream = await client.watch.withOptions({ signal: stop.signal });
  for await (const snapshot of stream) {
    const current = currentControlSnapshot(snapshot);
    // Render current.sessions; retain expiresAt, not a locally extended TTL.
    console.log(current.status, current.sessions);
  }
} finally {
  await client.close();
}
```

`close()` releases this client's connections. Iterator return and `AbortSignal` also release a
subscription, including a quiet stream or an iterator not yet consumed. Unary calls use Stitchkit's
configured HTTP client over a finite Unix transport. Subscriptions use its Fetch-config typed
client with a dedicated streaming Unix transport. Both retain framework validation and framing;
there is no custom HTTP parser, stream decoder, cancellation shim or application event engine.

`createControlProxy()` exposes the same unary contract as a peer-free Stitchkit `ServiceDef`.
`createToolInvoker(proxy, { transport: 'MCP' })` exercises canonical tool dispatch; an application
can pass the proxy to its own MCP/agent mount. Authorization is always checked at the daemon,
not trusted from an in-process tool context. Close the proxy with `proxy.close()`. CCMux does not
install an MCP server into existing provider sessions or change Desktop configuration.

# Bounds and freshness

- One existing observation pass every 2 seconds; subscribers create no provider connection,
  pane capture or transcript scan. Native state comes from the session supervisor's prepared file.
- Snapshots: at most 256 rows and 512 KiB, with explicit `omitted`. No transcript or message body,
  private launch settings or provider credentials appear in status DTOs.
- Availability (`live/stale/unavailable`) is distinct from execution state. Native approvals and
  input waits stay distinct. Expiry or clock skew clears positive execution claims. Consumers
  must re-evaluate `expiresAt` while retaining a snapshot; disconnect is not idle.
- First stream item is a full baseline. Pending revisions coalesce to one latest notice per reader;
  no durable replay is claimed. Reconnect gets a fresh generation/sequence baseline.
- At most 32 subscribers (including active resident waits); framework output buffering is at most
  16 framed items per connection. Frames are capped at 512 KiB + 1 KiB, heartbeats every 2 seconds.
  Unix transport applies physical socket backpressure; no cumulative lifetime cap on a stream.
- Mutations: 8 concurrent globally, 1 per target, at most 256 active target keys, no queue.
  Waits: 16 concurrent, deadline at most 60 seconds. Body/request cap: 64 KiB; client response
  header cap: 16 KiB; unary response cap: 512 KiB + 1 KiB. Client header deadline at most 65 seconds.
- Mutation caller budgets are 15 seconds (message/start) and 10 seconds (interrupt). A timed-out
  call retains its admission lease until its underlying operation really settles; retries must
  reconcile an immutable message ID. Capacity refusal is `BUSY`/429; draining is 503.

# Daemon lifecycle and verification

`createApplication` orders projection, local control owner/server, observation, freshness, delivery
and healing schedules. Schedules do not overlap; healing retains the configured interval. Stop
closes admission and streams, drains up to 5 seconds, then spends at most 2 seconds on forced
cleanup. SIGINT/SIGTERM retain exit codes 130/143 for boot-unit restart policy. `_run`, native
provider writers and tmux sessions are not application resources and survive daemon shutdown.
Operation audit records contain action/outcome/duration, never payloads or capability headers.

Tests: `test/control.test.ts`, `test/control-client-bundle.test.ts`, `test/monitoring-daemon.test.ts`
and `test/bundle-selfcontained.test.ts`. Explicit provider E2E: run
`scripts/codex-owned-runtime-probe.ts`, then `scripts/control-native-e2e.ts <isolated-config>`
and the native safety/recovery probes. These spend provider usage and only target isolated test
sessions. Rollback to the preceding native-runtime-capable release removes the new control API
without changing conversation UUIDs, chat storage or ordinary CLI behavior.
