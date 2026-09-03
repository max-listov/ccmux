---
title: Local resident session control
description: Typed same-user IPC, bounded live snapshots and managed daemon lifecycle without a second provider writer.
type: architecture
status: active
created: 2026-08-28
updated: 2026-08-31
---

# Ownership

Message admission, application attribution and notification suppression follow the
[message origin and audience contract](message-origin.md). Transport identity alone never proves
a human author, and conversation receipt is not a notification request.

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
External conversation reads use [bounded external content](external-content.md): exact
provider/machine/thread identity, authored-text pages and explicit unsupported controls, without
adopting an external writer.
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
| `create` / `create-session` | POST `/control/create` | Idempotent workspace-scoped runtime selection; omitted runtime is Codex |
| `runtimes` | POST `/control/runtimes` | Host runtime availability and explicit capabilities |
| `archive` / `archive-session` | POST `/control/archive` | Exact archive/stop receipt; history retained |
| `message` | POST `/control/message` | Durable acceptance, duplicate flag and pinned turn options |
| `start` | POST `/control/start` | Start existing non-archived identity; no duplicate writer |
| `interrupt` | POST `/control/interrupt` | Interrupt the exact active or suspended native turn |
| `native` / `native-items` | POST `/control/native` | Bounded content baseline/replay after an optional cursor |
| `models` | POST `/control/models` | Bounded provider-owned model catalog after an optional cursor |
| `directories` | POST `/control/directories` | Bounded names-only workspace directory page |
| `respond` / `respond-native` | POST `/control/native/respond` | Exact current approval/input response receipt |
| `wait` | POST `/control/wait` | Between-turn outcome, timeout or unavailable |
| `watch` | GET `/control-events/` | Absolute snapshots over typed NDJSON |
| `external` | GET `/control/external` | Prepared external native status; no lifecycle rights |
| `watchExternal` / `watch-external` | GET `/control-events/external` | External absolute snapshots, separate from managed rows |
| `watchNative` / `watch-native` | POST `/control-events/native` | Cursored native item frames with explicit resync |
| `selection` / `select` | POST `/control/selection` / `/control/selection/update` | Revisioned defaults, compare-and-swap between turns |
| `attachmentBegin/Chunk/Finalize/Cancel/Read` | POST `/control/attachment/<operation>` | Bounded authenticated PNG/JPEG transfer and preview |
| `steer` / `steeringOperation` | POST `/control/turn/steer` / `/control/turn/steering-operation` | Exact active-turn input and durable receipt |
| `messageOperation` | POST `/control/message/operation` | Caller-scoped retained message UUID → exact native turn/outcome |
| `history` | POST `/control/history` | Bounded provider-owned history page |
| `compact` / `contextOperation` | POST `/control/context/compact` / `/control/context/operation` | Native compaction admission and completion evidence |
| `fork` | POST `/control/fork` | Same-workspace native fork with a new managed identity |

The service uses the unversioned prefix `/ccmux/control`, envelope revision **current** and sole
native stream profile **ccmux-native**. There is no numbered dispatcher, compatibility client or
text-only alias. Envelope and cursor format guards remain strict; they do not select a legacy path. See
[native content and turn controls](native-content-and-turn-controls.md) for the current model,
attachment, content-replay, steering and context contracts.

`create` accepts an absolute workspace, a legal registry name, explicit native flags and a
caller-generated immutable request UUID. The workspace is normalized before the request fingerprint
is persisted. It reuses the same pending/promotion transaction as `ccmux new`; a lost reply or retry
reconciles the stable registration generation and cannot mint a second writer. Reusing the request
UUID for another name, workspace or flag set is `IDEMPOTENCY_CONFLICT`. `archive` marks the exact
identity before stopping its process group, so healing and routing stop while registry and provider
history remain available for deliberate resume.

`workspace` and session `dir` describe an execution directory, not a Product Project, Repository,
Checkout identity or harness workspace membership. Create accepts an existing directory without
requiring a Git root; multiple exact sessions can share that directory. Normalization belongs to
create idempotency, while fleet transport preserves the registered directory unchanged. Neither
normalization nor path-prefix matching establishes product membership or grants control authority.

Product-to-repository membership is explicit and many-to-many. A private companion repository may
belong to the same product; consuming a dependency does not automatically make it a member.
The consumer owns that private catalogue, independently of harness project labels. CCMux exposes
execution facts and exact session identities, not a project registry or inferred membership.

An optional `runtime` selects Claude, Codex or native OpenCode independently of inference selection.
Custom is discoverable but unavailable until the published optional harness is integrated and
verified. Native OpenCode stores its native continuation separately from the managed UUID; all
existing exact target fields remain required. Runtime/selection changes conflict with the original
request ID. See [managed runtime drivers](managed-runtime-drivers.md) for capabilities, native
protocol budgets and the supported host configuration boundary.

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
The catalog is the only authority on which model keys exist: `modelSelection.model` is bounded and
refuses whitespace and control characters, never a character allowlist — an allowlist is a second,
staler authority that refuses keys the runtime itself publishes.
Validation is a bounded metadata read, not a conversation. The selection is included in the create
fingerprint, durable session, launch stamp and immutable create receipt. A same-ID retry
with another selection is `IDEMPOTENCY_CONFLICT`; an accepted identical retry reconciles without
depending on catalog availability. Native start/resume passes the exact selection and checks the
provider's response. Revisioned `selection` in status describes future-turn defaults; `nativeSelection`
is separately sourced from native admission/settings or assistant evidence, never from that desired
default. Calls without selection retain
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
The accepted turn model always wins over `preset.model`: a Plan preset may supply mode and effort,
but cannot replace that model. Provider/authentication changes still require another runtime.
Create admission checks immutable identity; later turns use their own durably pinned options.

`message` requires a caller-generated immutable UUID. Retrying
the same sender/target/body/defer/notBefore/task with that UUID returns `duplicate: true`.
Reusing it for different content or identity is `IDEMPOTENCY_CONFLICT`. Acceptance means stored,
not delivered or completed. Existing delivery gates hold messages during busy turns, approvals,
input requests, partial composers and ambiguous native pickup. The API never types into those UI
states. `interrupt({target,generation,turnId})` requires the exact session identity, observer
generation and in-progress native turn ID. Working, waiting-approval and waiting-input are
cancellable; stale generation, unknown/idle state and a different turn refuse. The existing owner
rechecks before native cancellation and never answers or accepts an approval/input request.
Native acknowledgement means accepted cancellation, not terminal completion. Observe the exact
message operation or terminal stream event for completion. OpenCode retains an accepted interrupt
receipt for an idempotent repeat; an uncertain acknowledgement is never automatically replayed.
Codex native CAS refuses a turn that has already settled.

`native` projects assistant text, provider-public reasoning summaries, tool type/status, numeric
usage, terminal lifecycle and exact pending requests. Each tool record/history entry has a shared
typed `tool` observation; lifecycle completion alone never implies success. User messages belong to
authenticated `history`, not the hot content feed. Commands, output, diffs, arbitrary tool payloads
and credentials are not copied. Pending approvals may include bounded native filesystem patterns
needed for informed authorization; this explicit scope is separate from raw tool input.
Generation/sequence cursors return `records` for retained replay
or a bounded `baseline` with `reset=initial|generation|gap|context`. There is no old `items` field.

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

Every catalog source requires `runtime`, including the default/explicit Codex host read before
the first chat and exact managed-session reads. Runtime comes from the selected execution adapter,
never the inference provider. Session source runtime/machine must match its target; a mismatched
explicit selector is refused before provider contact. Pagination retains the same source identity.
Missing optional model metadata remains absent, not guessed from the runtime.

`models({ runtime: "opencode" })` instead uses OpenCode's configured-provider catalog, never the
universal model database or an OpenAI picker. Its source identifies the runtime and has nullable
provider because one native catalog can contain several configured providers. Each model row names
its provider. Source/runtime and exact session target must agree; no fallback switches runtimes.

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
separate fixed owner ingress at `/ccmux-control/invoke`. The transport constructs this strict
envelope:

```ts
{
  v: 1, id, caller,
  service: "ccmux.control", revision: "current",
  operation, payload: JSON.stringify(input),
}
```

`operation` is trusted outer metadata. The ingress selects one handler from it and only then parses
`payload` with the existing control input schema; a nested selector cannot change the handler.
The result is validated with the matching existing output schema and wrapped as
`{ v: 1, revision: "current", result }`. The ingress and local routes share one in-process operation
surface, mutation admission, wait admission, registry, chat ledger and native provider adapter.
It is not an HTTP-to-CLI proxy and cannot create another provider writer.

The release asset `ccmux-control-service-client-<version>.tgz` contains the typed injected-fetch
client, `descriptor.json`, `native-stream.json` and declarations. Its adjacent
`control-service-client.sha256` authenticates the artifact. The same surface is available from
`ccmux/control-service-client` in a source checkout. `ccmuxControlServiceComposition` contains only
virtual routing metadata and the descriptor. It grants nothing and opens no connection. The
operator owns the private ingress socket path, node binding, credentials and exact
service/revision/operation/effect grants.

`message.cancel` withdraws one letter the caller itself queued and that has not been delivered. The
mechanism was already there — a cancel tombstone in the ack log — reachable only from the command
line, so a consumer's stop button answered "nothing to stop" about a letter it had sent and that was
sitting waiting for a turn boundary. By id, and only the caller's own. Its four outcomes stay apart
because they ask different things of a caller: `cancelled` will not arrive, `delivered` already has,
`unknown` is no such letter here, and `not-yours` is one that exists and belongs to someone else —
said plainly rather than disguised as `unknown`, which would make a permissions answer look like a
missing one. An immediate letter answers `delivered`: it is delivered off the in-order cursor and
never waits, so there is no interval in which to take it back.

`transcript.read` answers a bounded window of a session's conversation — the newest `tail`,
everything after a `cursor`, or a page `before` a line — with the same builder and the same cursor
the `transcript` command uses, so a consumer pages through one conversation rather than two views of
it. It exists because a consumer watching several conversations was paying a process launch per
question; the read itself costs its window rather than the file (see the transcript index), and this
removes what was left. The window is bounded in the request schema, so an over-large ask is refused
by name instead of by a transport size error after the work is done.

The descriptor declares the current operations and their individual byte/deadline budgets. A remote wait is capped
at 25 seconds inside a 30-second service deadline. Service delivery is never retried by the owner
client. If transport delivery is unknown, the caller retains that uncertainty. An idempotent
`session.create` may deliberately retry the same immutable `requestId`: the durable create receipt
reconciles one registration generation and one writer. Other mutations require their own exact
idempotency identity or an authoritative read before any caller-selected retry.

Revision 2 effects are dot-delimited authorization identifiers. Operation metadata, typed client
and `descriptor.json` read the same owner mapping in `src/control/serviceCatalog.ts`. Every service,
operation and effect identifier satisfies `^[a-z0-9][a-z0-9._-]*$`. Operators consume the current
descriptor unchanged and explicitly grant the operations needed, including separate attachment,
selection, history/context, fork and steering effects. Obsolete descriptors are refused, not
translated into another compatibility path.

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
bytes. The producer repeats an unexpired snapshot every two seconds as a heartbeat with the same cursor;
the shared subscription refreshes native lease/settings metadata without manufacturing content sequence.
An expired lease terminates the producer instead of repeating a falsely live frame.
Reconnect passes that cursor back in the next typed stdin request: a matching generation resumes after the sequence, while a new
generation or retained-window miss returns the canonical `generation` or `gap` reset snapshot.
Cancellation aborts the local subscription and closes both Unix transports. No workspace path,
provider credential, arbitrary executable, shell text or consumer-owned parser crosses this API.

The frame budget belongs to the wire, not to this project: the transport buffers the producer's
NDJSON at twice its chunk bound and separately refuses a framed chunk whose `data` exceeds that
bound, and both the schema maximum and the default of that knob are 32 KiB. Frames are therefore
measured against 32 KiB of `data` inside a 64 KiB line, and the measurement is taken on the
serialized line rather than on the payload — `data` is JSON inside a JSON string, so content
carrying code is escaped twice over.

A snapshot larger than that has an honest smaller form and is sent in it: oldest records go first,
then baseline entries, both counted into `omittedRecords`; pending requests go last and only when
nothing observational remains, counted into `omittedPending`, because they are the one part of the
frame a human can act on. Shedding pending frees budget, so content is searched again afterwards
rather than staying shed for a reason that no longer applies. A single approval prompt at its schema
maximum is larger than the whole budget, so this path is reachable from legal data alone.

When identity or fixed metadata alone exceeds the budget there is no honest smaller frame, and the
producer refuses rather than emitting a line no consumer can parse. Refusals are one stderr object,
`{ error, retryable }`: `FRAME_UNREPRESENTABLE` and `INPUT_TOO_LARGE` are `retryable: false` because
a reconnect returns to exactly the same input, and `STREAM_UNAVAILABLE` is `retryable: true`. An
oversized frame does not degrade a consumer — it ends its stream, and the reconnect that follows
fetches the same line again.

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
  latest notice per reader. Native content replays only its bounded retained window; generation
  changes or gaps explicitly reset it. Provider history is a separate bounded native read.
- At most 32 subscribers (including active resident waits); framework output buffering is at most
  16 framed items per connection. Native stream frames are capped at 64 KiB of line carrying at most
  32 KiB of payload — the transport's bound, not this project's — heartbeats every 2 seconds.
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
outcomes retain their existing meaning. The single reader in `src/fleet/wireProtocol.ts` requires
door2 version, ID, timestamp, sender, integer code, both streams, failure, refusal, retry hint,
detail and truncation. Additive keys are ignored; missing fields, unknown enum values and
contradictory refusal/retry fields cannot become success. There is no private client artifact in
the public install, daemon start, automatic arbitrary-command replay or SSH fallback.

`RemoteResult.delivery` is independent of command exit: `not-sent` requires local pre-dispatch
evidence or a structured pre-execution refusal; timeout, malformed reply and after-dispatch loss
are `unknown`; a valid command/exec verdict is `received`. SSH exit 255/timeouts are unknown.
Mutating CLI relays warn against blind replay when execution is unknown. The chat outbox alone
retries an immutable envelope through atomic receiver deduplication, including a lost first ACK.

# Daemon lifecycle and verification

`createApplication` orders managed/external projections, local control owner/server, independent
managed/external observation, freshness, delivery and healing schedules. Schedules do not overlap;
healing retains the configured interval. Stop
closes admission and streams, drains up to 5 seconds, then spends at most 2 seconds on forced
cleanup. SIGINT/SIGTERM retain exit codes 130/143 for boot-unit restart policy. `_run`, native
provider writers and tmux sessions are not application resources and survive daemon shutdown.
Operation audit records contain action/outcome/duration, never payloads or capability headers.

Stitchkit 0.70.5 owns cooperative HTTP stream cancellation when admission closes. Native feed
sources receive their existing signal and finish before the server resource reports closed;
consumers do not have to abort first or install a separate shutdown wrapper. Finite requests keep
their drain budget, and uncooperative cleanup is still reported as pending/failed. The native
stream regression and real-provider acceptance keep a reader subscribed during daemon replacement
and require a clean self-report plus preserved session/message identity, not merely healthy restart.

### Exact message correlation

The declared service operation `message.operation` (effect `message.read`) and both typed clients'
`messageOperation({target, registrationGeneration, messageId})` expose retained native receipts.
Request/response are capped at 8 KiB each; the descriptor deadline is five seconds. `message.send`
still means durable queue acceptance only. Persist the create receipt's target/generation and your
message UUID, then read the operation without replaying a mutation:

```ts
const operation = await client.messageOperation({ target, registrationGeneration, messageId });
if (operation.outcome === 'available' && operation.evidence?.state === 'completed') {
  // Join native content/history by this exact turnId, never by text or sequence order.
  const turnId = operation.evidence.turnId;
}
```

`outcome` is `available`, `expired` or `unavailable`; only available results carry `evidence`.
Evidence contains `state`, `nativeSession: {runtime,id}`, `turnId`, `observedAt` and `expiresAt`.
Queued/uncertain states have no proven turn ID; admitted/completed/interrupted/failed do. Preparing
acceptance is publicly uncertain. Native bootstrap/other-caller turns need not have an accessible
binding. An unauthorized caller, wrong generation, missing/corrupt/evicted record gets unavailable.

These are durable last-observed receipts, not provider-liveness claims. Reads are bounded metadata
only and never call a provider, scan history or repair/replay. Retention is 256 records per managed
registration, at most 512 KiB, and up to seven days after terminal completion (capacity may evict
terminal rows sooner). Pending rows are not evicted. Pre-retention messages and CLI/peer submissions
return unavailable; no retrospective heuristic or duplicate execution is introduced. See the
[decision](../decisions/2026-08-30-public-message-native-turn-correlation.md) for crash ordering.

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

`scripts/remote-image-acceptance.ts` exports `remoteImageAcceptance(service, options)` for a typed
service client backed by an authenticated cross-machine transport. Supply a dedicated existing
test workspace and unique fixture prefix; no host names, credentials or transport configuration
are embedded in the script. It creates and archives exact managed Codex/OpenCode fixtures, uses
explicit conversation-only notification audience, and transfers locally generated PNG/JPEG bytes
only through attachment operations. Acceptance includes image-only input, both multiple-image
orders, same-ID retry/conflict, an input larger than the message envelope and a near-limit image
on each runtime. Native completion is correlated by message ID and registration generation;
bounded history, retained preview and safe native content are checked against that exact turn.
Run against the checksum-verified published client and installed owner for release qualification.

`scripts/control-model-selection-acceptance.ts [ccmux-entrypoint] [published-client-module]` uses isolated
state and an isolated tmux socket with native authentication. The optional client module is the
extracted, checksum-verified service package's `dist/index.js`; supplying it together with the
installed CCMux entrypoint tests the published boundary rather than only source imports.
It proves empty-inventory service discovery, directory reads,
two catalog models under one profile, native shell execution in Plan, same-ID refusal/retry, and
provider/daemon restart. Tool acceptance requires a completed native `commandExecution` item and
the terminal response, not merely any tool item. Its differing-preset test explicitly substitutes just that capability field
before sending the resulting policy into a real native turn; the installed preset itself may report
`model: null`. The probe records this distinction rather than claiming a provider-advertised mismatch.
