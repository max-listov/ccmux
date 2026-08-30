---
title: Local resident session control
description: Typed same-user IPC, bounded live snapshots and managed daemon lifecycle without a second provider writer.
type: architecture
status: active
created: 2026-08-28
updated: 2026-08-30
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

Managed operations and `list`/`watch` contain only registered managed sessions. The same listener
also exposes a separate read-only [external native projection](external-resident-status.md).
Desktop-owned threads are not imported, adopted, restarted or counted as managed sessions.
Their observation prerequisites remain separate. No TCP listener or fleet-routing replacement is added.

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
| `create` / `create-session` | POST `/control/create` | Idempotent workspace-scoped owned Codex creation |
| `archive` / `archive-session` | POST `/control/archive` | Exact archive/stop receipt; history retained |
| `message` | POST `/control/message` | Durable acceptance and duplicate flag |
| `start` | POST `/control/start` | Start existing non-archived identity; no duplicate writer |
| `interrupt` | POST `/control/interrupt` | Interrupt the exact working native turn |
| `native` / `native-items` | POST `/control/native` | Bounded native-item snapshot after an optional cursor |
| `models` | POST `/control/models` | Bounded provider-owned model catalog after an optional cursor |
| `directories` | POST `/control/directories` | Bounded names-only workspace directory page |
| `respond` / `respond-native` | POST `/control/native/respond` | Exact current approval/input response receipt |
| `wait` | POST `/control/wait` | Between-turn outcome, timeout or unavailable |
| `watch` | GET `/control-events/` | Absolute snapshots over typed NDJSON |
| `external` | GET `/control/external` | Prepared external native status; no lifecycle rights |
| `watchExternal` / `watch-external` | GET `/control-events/external` | External absolute snapshots, separate from managed rows |
| `watchNative` / `watch-native` | POST `/control-events/native` | Cursored native item frames with explicit resync |

`create` accepts an absolute workspace, a legal registry name, explicit native flags and a
caller-generated immutable request UUID. The workspace is normalized before the request fingerprint
is persisted. It reuses the same pending/promotion transaction as `ccmux new`; a lost reply or retry
reconciles the stable registration generation and cannot mint a second writer. Reusing the request
UUID for another name, workspace or flag set is `IDEMPOTENCY_CONFLICT`. `archive` marks the exact
identity before stopping its process group, so healing and routing stop while registry and provider
history remain available for deliberate resume.

An optional `launchRecipe: { id, revision }` selects an execution-host definition. In that form
caller flags must be empty: native flags, an optional existing session `envFile`, required
environment variable names and model-provider configuration are all owner configuration. The host
validates the native allowlist and environment availability before writing a receipt, reserving a
registry generation or spawning Codex, then fingerprints the canonical recipe digest with the
request. Unknown, removed, changed or unavailable definitions return the generic
`LAUNCH_RECIPE_UNAVAILABLE`; the owner log retains the exact cause. A same-ID retry can only
reconcile the accepted digest and one writer.

The session persists `{ id, revision, digest, capabilities, collaborationMode? }` beside the already-existing resolved
`flags` and `envFile`. App Server bootstrap, provider restart and daemon reconciliation revalidate
that immutable host definition before spawn and resume the same UUID. Create receipts, managed rows
and native snapshots may carry only that safe metadata. Recipe fields, paths, environment names and
values never cross the control boundary. Recipe-less create omits the field and keeps the existing
behavior. The rationale and failure model are recorded in
[server-owned control launch recipes](../decisions/2026-08-29-server-owned-control-launch-recipes.md).

`modelSelection: { provider, model }` is separate from the launch recipe. One authenticated host
profile can launch different catalog models without one recipe per model. Typed selection refuses
caller flags; the selected provider must match effective native host configuration. OpenAI model
selection is checked against the native catalog before a create receipt or registry mutation.
Validation is a bounded metadata read, not a conversation. The selection is included in the create
fingerprint, durable session, launch stamp and safe receipt/status/native projection. A same-ID retry
with another selection is `IDEMPOTENCY_CONFLICT`; an accepted identical retry reconciles without
depending on catalog availability. Native start/resume passes the exact selection and checks the
provider's response. Selection survives daemon/provider restart. Calls without selection retain
the native default and existing known-model recipe behavior. Custom-provider configuration remains
host-owned; this interface does not aggregate or proxy external inference services.

An optional recipe `collaborationMode` selects only an installed App Server preset. Before each
managed `turn/start`—bootstrap, immediate or deferred delivery, and delivery after restart—CCMux
reads `collaborationMode/list`, verifies the requested mode and combines the preset with the loaded
thread model. It sends `developer_instructions: null`, which delegates instructions to the
provider's built-in preset. Missing support returns generic `COLLABORATION_MODE_UNAVAILABLE` before
pickup intent or turn acceptance; the owner log keeps the exact probe failure. The existing native
pending request and exact response contract remains the sole input path. See the
[managed collaboration policy decision](../decisions/2026-08-29-managed-codex-collaboration-policy.md).
The loaded thread model always wins over `preset.model`: a Plan preset may supply mode and effort,
but cannot replace the selected model. A loaded thread that differs from a pinned selection fails
closed before turn submission.

`message` requires a caller-generated immutable UUID. Retrying
the same sender/target/body/defer/notBefore/task with that UUID returns `duplicate: true`.
Reusing it for different content or identity is `IDEMPOTENCY_CONFLICT`. Acceptance means stored,
not delivered or completed. Existing delivery gates hold messages during busy turns, approvals,
input requests, partial composers and ambiguous native pickup. The API never types into those UI
states. `interrupt` requires both the exact session identity and current native turn ID, rechecks
provider state and never answers an approval or input request.

`native` projects only known native item fields: user/assistant text, bounded reasoning summaries,
tool type/status, numeric usage, terminal state and approval/input prompts. Commands, output,
working directories, diffs, arbitrary tool payloads and credentials are not copied. The snapshot
generation plus sequence is the cursor. A first read, runtime generation change or retained-window
gap returns `reset=initial|generation|gap`; the included bounded snapshot is authoritative.

`models({})` reads the native App Server catalog before the first conversation, with no managed
target or registry row. An optional `launchRecipe: { id, revision }` selects host-owned configuration;
a host-catalog env source must be absolute or home-relative, not workspace-relative. CCMux starts
one short-lived metadata App Server with the existing native flags/session-environment mechanism,
initializes it, reads `config/read` and `model/list`, then closes the socket and reaps its entire
process group. It never calls `thread/start` or `thread/resume`. Failure retains only the last
bounded diagnostic in owner-only `control/catalog-diagnostic.json` (0600), never in the response.

An optional exact `target` instead connects to that session's own socket; target and launch recipe
are mutually exclusive. There is no fallback to a machine socket or another session. The returned
`source: { kind: "host" | "session", machine, provider, launchRecipe? }` names the actual scope;
`target` is echoed only for a session read. Unsupported custom-provider catalogs are refused, never
relabeled from OpenAI picker metadata. The caller supplies no credentials, paths, argv or executable.
Every read uses the existing global read admission and deadline. Other inputs are
`cursor` (opaque, ≤ 4 KiB), `limit` (1–64, default 64) and `includeHidden`; one call returns one
page plus the provider's `nextCursor`, so pagination is deterministic and never loops the
provider internally. Only selector metadata crosses the boundary: preset `id`, native `model` when
reported (use `model ?? id` for create selection), display name, description,
default and hidden markers, input modalities, service tiers and supported/default reasoning
efforts when present. Provider errors, deadline and malformed or oversized pages fail closed as
`UNAVAILABLE`/`TIMEOUT` — no static or local catalog is ever substituted, and a model from a
different runtime is never reported.

`directories({ path?, cursor?, limit?, includeHidden? })` is a read-only folder-picker operation.
Omitted path means the service user's home; explicit paths must be absolute. Results contain the
resolved `path`, nullable `parent`, and names/paths/kinds (`dir`, `file`, `symlink`, `other`), never
contents, sizes or timestamps. Dotfiles require `includeHidden: true`. Symlink entries are reported
but a symlink in the requested path is refused (`SYMLINK_REFUSED`). This is same-user convenience,
not a filesystem sandbox or an adversarial path-swap security boundary.

The listing scans at most 20,000 entries, returns at most 512 (default 128) within 240 KiB of entry
data, and shares the four-reader, five-second budget. The opaque cursor binds path, hidden selector,
directory inode/version and last name. Changed directories yield `STALE_CURSOR`, requiring a fresh
listing instead of silently skipping entries. Errors include `NOT_FOUND`, `NOT_A_DIRECTORY`,
`PERMISSION_DENIED`, `DIRECTORY_TOO_LARGE` and `INVALID_CURSOR`; messages do not leak another path.
Listing is advisory: create still accepts any accessible absolute workspace, not a listing whitelist.

`respond` addresses the exact target, projection generation and current request ID. Approval
decisions are restricted to the provider-advertised simple choices: `accept`, `acceptForSession`,
`decline` or `cancel`; structured policy amendments are not exposed. Input answers must cover the
exact question ID set. A private same-user mailbox forwards the command to the session supervisor,
which responds over the same App Server connection that received the request.
`submitted` means the JSON-RPC response was written; `serverRequest/resolved` remains the provider's
separate resolution boundary. A timeout returns `uncertain`, never false delivery. Stale,
mismatched, terminal and already-resolved requests fail closed.

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

Create and follow an owned workspace without polling provider history:

```ts
const catalog = await client.models({}); // no conversation required
const choice = catalog.data.find((model) => model.isDefault);
if (!choice) throw new Error("No model available");
const created = await client.create({
  requestId: crypto.randomUUID(), name: "worker", workspace: "/absolute/workspace", flags: [],
  modelSelection: { provider: catalog.source.provider, model: choice.model ?? choice.id },
});
const native = await client.native({ target: created.target, cursor: null });
const feed = await client.watchNative.withOptions({
  target: created.target, cursor: { generation: native.generation, sequence: native.sequence },
}, { signal: stop.signal });
```

Selecting a host recipe sends only its safe immutable reference:

```ts
const created = await client.create({
  requestId: crypto.randomUUID(),
  name: "worker",
  workspace: "/absolute/workspace",
  flags: [],
  launchRecipe: { id: "provider-a", revision: "r1" },
});
console.log(created.launchRecipe); // id, revision, digest, public-safe capabilities/mode
```

One possible execution-host declaration is:

```json
{
  "launchRecipes": {
    "provider-a": {
      "revision": "r1",
      "envFile": "~/.config/ccmux/provider-a.env",
      "flags": [
        "-c", "model_provider=\"provider-a\"",
        "-c", "model_providers.provider-a.name=\"Provider A\"",
        "-c", "model_providers.provider-a.base_url=\"https://api.example.invalid/v1\"",
        "-c", "model_providers.provider-a.env_key=\"MODEL_SERVICE_TOKEN\"",
        "-c", "model_providers.provider-a.wire_api=\"responses\""
      ],
      "environment": ["MODEL_SERVICE_TOKEN"],
      "capabilities": ["external-provider", "responses", "input-requests"],
      "collaborationMode": "plan"
    }
  }
}
```

The env file contains the value and never crosses the API or appears in process argv. Changing any
definition field requires a new revision for new calls; accepted receipts and sessions additionally
pin the computed digest. Machine configuration changes require the normal daemon restart before the
control service accepts the new definition.

`close()` releases this client's connections. Iterator return and `AbortSignal` also release a
subscription, including a quiet stream or an iterator not yet consumed. Both contracts use
Stitchkit's configured HTTP client. Unary calls use a finite Unix transport; subscriptions use
a separate streaming Unix transport. The header deadline ends at response headers, while caller
cancellation remains attached through body ownership. Both retain framework validation and framing;
there is no custom HTTP parser, stream decoder, cancellation shim or application event engine.

`createControlProxy()` exposes the same unary contract as a peer-free Stitchkit `ServiceDef`.
`createToolInvoker(proxy, { transport: 'MCP' })` exercises canonical tool dispatch; an application
can pass the proxy to its own MCP/agent mount. Authorization is always checked at the daemon,
not trusted from an in-process tool context. Close the proxy with `proxy.close()`. CCMux does not
install an MCP server into existing provider sessions or change Desktop configuration.

# Declared service and native stream binding

The local control routes remain a same-user API and are never exposed directly as a remote
service. A transport that already authenticates nodes and grants declared operations binds the
separate fixed owner ingress at `/ccmux-control/v1/invoke`. The transport constructs this strict
envelope:

```ts
{
  v: 1, id, caller,
  service: "ccmux.control", revision: "1",
  operation, payload: JSON.stringify(input),
}
```

`operation` is trusted outer metadata. The ingress selects one handler from it and only then parses
`payload` with the existing control input schema; a nested selector cannot change the handler.
The result is validated with the matching existing output schema and wrapped as
`{ v: 1, revision: "1", result }`. The ingress and local routes share one in-process operation
surface, mutation admission, wait admission, registry, chat ledger and native provider adapter.
It is not an HTTP-to-CLI proxy and cannot create another provider writer.

The release asset `ccmux-control-service-client-<version>.tgz` contains the typed injected-fetch
client, `descriptor.json`, `native-stream.json` and declarations. Its adjacent
`control-service-client.sha256` authenticates the artifact. The same surface is available from
`ccmux/control-service-client` in a source checkout. `ccmuxControlServiceComposition` contains only
virtual routing metadata and the descriptor. It grants nothing and opens no connection. The
operator owns the private ingress socket path, node binding, credentials and exact
service/revision/operation/effect grants.

The descriptor declares eleven operations and their byte/deadline budgets. A remote wait is capped
at 25 seconds inside a 30-second service deadline. Service delivery is never retried by the owner
client. If transport delivery is unknown, the caller retains that uncertainty. An idempotent
`session.create` may deliberately retry the same immutable `requestId`: the durable create receipt
reconciles one registration generation and one writer. Other mutations require their own exact
idempotency identity or an authoritative read before any caller-selected retry.

Revision 1 effects are stable dot-delimited authorization identifiers: `session.read`,
`session.create`, `session.archive`, `message.send`, `session.start`, `turn.interrupt`,
`native.read`, `native.respond`, `session.wait`, `model.read` and `directory.read`. Operation metadata, the typed
client contract and `descriptor.json` all read them from one owner mapping. Every service,
operation and effect identifier satisfies `^[a-z0-9][a-z0-9._-]*$`; an operator must feed the
descriptor unchanged into its declared-service policy parser. A valid activated revision pins its
effects and requires a new revision for any later authorization-identity change. The `model.read`
and `directory.read` additions preserve earlier effect identifiers. Operators explicitly grant new
operations when adopting the updated descriptor. A descriptor that cannot pass the policy parser cannot have a valid
activation or grant migration; correcting that descriptor retains its unactivated revision.

Native updates use a separate fixed stream producer, not unary polling. An allowlisted profile is
created with `createCcmuxNativeStreamProfile(<absolute standard ccmux executable>)`. The standard
installer writes that executable as a POSIX `/bin/sh` shim with absolute Bun and bundle paths and
replaces it atomically. It therefore runs with the profile's empty environment; `PATH`, a
caller-authored wrapper and copied argv are not prerequisites. Bundle upgrades and rollback retain
the same stable executable while atomically replacing the bundle it launches. Every other field is
owner-fixed: command `control-native-stream`, no caller argv, one strict target on bounded stdin,
no inherited environment, stable-cursor NDJSON, four concurrent producers, a 15-minute deadline
and a 64 MiB total ceiling. The typed stdin request contains the exact target and an optional
owner cursor; it contains no path, executable, credential or operation selector.

Each producer line is exactly `{ channel: "data", data, cursor }`. `data` is a validated bounded
`ControlNativeSnapshot`; `cursor` binds exact target, generation and sequence and is capped at 512
bytes. The producer repeats the last snapshot every two seconds as a heartbeat with the same cursor.
Reconnect passes that cursor back in the next typed stdin request: a matching generation resumes after the sequence, while a new
generation or retained-window miss returns the canonical `generation` or `gap` reset snapshot.
Cancellation aborts the local subscription and closes both Unix transports. No workspace path,
provider credential, arbitrary executable, shell text or consumer-owned parser crosses this API.

# Bounds and freshness

- One existing observation pass every 2 seconds; subscribers create no provider connection,
  pane capture or transcript scan. Native state comes from the session supervisor's prepared file.
- Snapshots: at most 256 rows and 512 KiB, with explicit `omitted`. No transcript or message body,
  private launch settings or provider credentials appear in status DTOs.
- Availability (`live/stale/unavailable`) is distinct from execution state. Native approvals and
  input waits stay distinct. Expiry or clock skew clears positive execution claims. Consumers
  must re-evaluate `expiresAt` while retaining a snapshot; disconnect is not idle.
- Managed status streams begin with a full baseline. Native streams begin with a cursor-relative
  frame and carry an explicit reset when a baseline is required. Pending revisions coalesce to one
  latest notice per reader; no durable replay is claimed. Reconnect gets a fresh
  generation/sequence baseline.
- At most 32 subscribers (including active resident waits); framework output buffering is at most
  16 framed items per connection. Frames are capped at 512 KiB + 1 KiB, heartbeats every 2 seconds.
  Unix transport applies physical socket backpressure; no cumulative lifetime cap on a stream.
- Mutations: 8 concurrent globally, 1 per target, at most 256 active target keys, no queue.
  Waits: 16 concurrent, deadline at most 60 seconds. Provider model reads: 4 concurrent with a
  5-second deadline; one page holds at most 64 models and the declared-service response budget is
  256 KiB. Body/request cap: 64 KiB; client response
  header cap: 16 KiB; shared unary response cap: 1 MiB + 1 KiB to accommodate external snapshots.
  Managed snapshot bounds remain 512 KiB. Client header deadline at most 65 seconds.
- Mutation caller budgets are 60 seconds (create), 15 seconds (message/start/archive), and 10 seconds
  (interrupt/respond). A timed-out
  call retains its admission lease until its underlying operation really settles; retries must
  reconcile an immutable message ID. Capacity refusal is `BUSY`/429; draining is 503.

The optional local fleet door uses the existing public Stitchkit Unix transport directly. Unary
replies have a 52 MiB cumulative ceiling, 64 KiB header ceiling, 8 MiB request ceiling, one owned
connection per call and a deadline that includes body completion. Cancellation, malformed framing,
oversize and stalled bodies close the socket before returning. The door protocol remains parsed by
CCMux so additive fields, version refusal, command exit, truncation and policy/request/capacity
outcomes retain their existing meaning. There is no private client artifact in the public install,
no socket discovery, daemon start, automatic replay or SSH fallback.

# Daemon lifecycle and verification

`createApplication` orders managed/external projections, local control owner/server, independent
managed/external observation, freshness, delivery and healing schedules. Schedules do not overlap;
healing retains the configured interval. Stop
closes admission and streams, drains up to 5 seconds, then spends at most 2 seconds on forced
cleanup. SIGINT/SIGTERM retain exit codes 130/143 for boot-unit restart policy. `_run`, native
provider writers and tmux sessions are not application resources and survive daemon shutdown.
Operation audit records contain action/outcome/duration, never payloads or capability headers.

Automatic updates return a verified-installation outcome to the healing schedule. A subsequent
event-loop turn requests the normal SIGTERM/exit-143 path, allowing that schedule to settle before
drain; the existing boot unit starts the new artifact. The daemon never awaits a service-manager
restart of itself. Manual CLI updates retain their ordinary service-manager restart. The bundled
daemon regression in `test/daemon-update.test.ts` verifies install, clean shutdown and restart.

Tests: `test/control.test.ts`, `test/control-service.test.ts`, `test/control-lifecycle.test.ts`, `test/control-models.test.ts`, `test/codex-owned-connection.test.ts`,
`test/control-client-bundle.test.ts`, `test/monitoring-daemon.test.ts`
and `test/bundle-selfcontained.test.ts`. `scripts/verify-control-service-client.ts` installs the
fresh tarball outside the checkout and runs Bun, Node, NodeNext and bundler gates. Explicit provider E2E: run
`scripts/codex-owned-runtime-probe.ts`, then
`scripts/codex-control-lifecycle-probe.ts <isolated-config>`,
`scripts/control-native-e2e.ts <isolated-config>`, `scripts/control-models-e2e.ts` and the native
safety/recovery probes. These spend
provider usage and only target isolated test sessions; the model-catalog probe is read-only. Rollback to the preceding
native-runtime-capable release removes the new control API
without changing conversation UUIDs, chat storage or ordinary CLI behavior.

`scripts/control-model-selection-acceptance.ts [ccmux-entrypoint]` uses isolated state and an isolated
tmux socket with native authentication. It proves empty-inventory service discovery, directory reads,
two catalog models under one profile, native shell execution in Plan, same-ID refusal/retry, and
provider/daemon restart. Its differing-preset test explicitly substitutes just that capability field
before sending the resulting policy into a real native turn; the installed preset itself may report
`model: null`. The probe records this distinction rather than claiming a provider-advertised mismatch.
