---
title: Resident external native session status
description: One daemon-owned observer exposes bounded external thread snapshots and streams without adopting their writers.
type: architecture
status: active
created: 2026-08-28
updated: 2026-08-28
---

# Authority and coverage

The existing CCMux daemon observes the configured Codex App Server through its existing Unix
control socket. It never starts the provider, resumes a thread, answers an approval, or imports
external identities into the managed registry. The observer is independent of the full external
inventory's process/lock/transcript discovery. Multiple consumers share one connection and one
prepared projection.

The connected runtime is the authority, not the host's process list. A healthy connection does
**not** prove that every Desktop thread is loaded by that runtime. In particular, a local Desktop
using private stdio can coexist with a different connectable App Server. Its `notLoaded` answers
remain unknown; they must not be converted to idle or used as proof that Desktop has stopped.
An existing remote Desktop runtime exposing the native socket can be observed without migration.
This interface does not add a connection route to a stdio-only Desktop runtime.

Native `active` maps to working, its approval/input flags map to distinct waiting states, and
native `idle` maps to idle. Unsupported flags, `notLoaded` and `systemError` remain unknown.
No inference uses writer locks, activity age, titles, transcript tails or an application-native tool.

# Source lifecycle

One observer registers notifications before its initial read. It requests `thread/list` with
`useStateDbOnly: true`, then reconciles every 2 seconds with no overlapping pass. Each pass has
a 2-second total deadline, at most 4 pages of 128 rows and 2 MiB per native message. The verified
native-version floor is shared with the on-demand external reader; older or unrecognized
runtimes receive no potentially scanning list request. Native metadata may contain additional
fields, but only UUID, title, cwd, update time and status are projected. No transcript body,
preview, provider path, launch settings or credentials cross the public status boundary.

`thread/status/changed` updates reach the prepared projection immediately. A notification newer
than the start of a reconciliation wins over that pass's older response. Notifications do not
extend unrelated rows' leases or replace a successful complete reconciliation. The event overlay
holds at most 512 identities. A connection that is ESTABLISHED replaces the generation and
invalidates old positive observations before rebuilding state; an attempt that fails does not.
The distinction is the consumer's: it must retire every generation it is shown and its retired set
is bounded, so a generation minted per attempt spends that budget on an event that did not happen —
on a machine whose provider is absent, seven of them in twelve seconds beside an unbroken sequence,
which announces that the numbering restarted while it plainly did not. For the same reason a
repeated identical refusal is not re-published: the same status and reason said again is not news,
and re-announcing `observation-pending` on every retry would overwrite the failure reason that
carries the information with one that carries none. Late events from retired connections have no
effect. A successful empty inventory removes rows; a failed observation retains last-known metadata
but clears positive execution claims. Root changes invalidate the old source before reconnecting.

No consumer read, subscription or reconnect causes a provider request, CLI spawn, pane capture or
transcript scan. Daemon shutdown closes observer connections, not external provider processes.

# Published contract

Use the same protected `control/api.sock` and authentication/discovery as the
[managed control API](control-plane.md). Directory mode is 0700, socket mode 0600; browser Origin
requests are refused. There is no TCP listener, caller-selected provider path or second daemon.

| Client / CLI | HTTP | Result |
| --- | --- | --- |
| `external()` / `ccmux control external --json` | GET `/control/external` | Prepared external snapshot |
| `watchExternal()` / `ccmux control watch-external` | GET `/control-events/external` | Full baselines and subsequent absolute snapshots |

`ccmux external --json` remains the explicit, slower discovery/adoption inventory. It is not the
resident API and should not be run on each status tick. Managed `list`/`watch`, registry and fleet
counts retain their previous meanings.

Protocol 1 snapshots carry version, machine, connection generation, monotonic sequence, source,
availability, reason, observation/expiry times, `truncated`, `omitted` and `sessions`. Each row has
`identity: { provider: 'codex', machine, threadId }`, nullable native title/cwd/update time and the
existing `turnState` object. Join by exact provider + machine + thread UUID, never title or cwd.
This is read-only identity, not a managed-session command target.

Bounds are 512 rows and 1 MiB per snapshot; positive observations take priority over unknown
history when the byte limit is reached. `omitted` counts rows dropped from the fetched set;
`truncated` also covers an unvisited native page, whose exact omitted count is not known. A
truncated projection cannot establish a complete fleet total. No empty or partial projection
can establish the absence of a thread from a different runtime.

Observation leases last 5 seconds, conservatively measured from reconciliation start. Availability
is `live`, `stale` or `unavailable`, independently of per-thread execution. Deadline, malformed
responses, disconnect, unsupported runtime, clock skew and config changes never mean idle.
The consumer must apply `currentExternalStatus(snapshot)` while retaining cached data, and mark
a disconnected transport unavailable immediately rather than retaining a positive count.

There are at most 32 external subscribers, separate from the managed subscriber budget. Each
pending reader retains one latest revision notice; framework output is bounded to 16 framed
items. Native HTTP NDJSON frames are capped at 1 MiB + 1 KiB with 2-second heartbeats. CLI output
is one unwrapped snapshot JSON per line with stdout backpressure. Reconnect starts with a full
baseline, not replay. Caller abort/iterator return closes only its reader; a quiet stream has no
cumulative lifetime deadline. After state-root or machine-identity change, restart the daemon
and rediscover the IPC location. A changed Codex home reconnects the observer without adopting data.

# Resident example and fleet use

The release's self-contained `control-client.js` includes this API and Zod schemas; verify its
SHA-256 asset before loading. A Bun consumer can also import the package entry point:

```ts
import { createControlClient, currentExternalStatus } from 'ccmux/control-client';

const client = createControlClient();
const stop = new AbortController();
try {
  const stream = await client.watchExternal.withOptions({ signal: stop.signal });
  for await (const snapshot of stream) {
    const current = currentExternalStatus(snapshot);
    console.log(current.machine, current.status, current.sessions);
    // Retained UI state must also re-evaluate expiresAt between deliveries.
  }
} finally {
  stop.abort();
  await client.close();
}
```

Fleet consumers keep independent connections and freshness state per host. Over configured SSH,
run one long-lived `ccmux control watch-external` per host, rather than one CLI per refresh:

```sh
ssh -o BatchMode=yes -o ControlMaster=no -o ConnectTimeout=10 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 host-a \
  'ccmux control watch-external'
```

Validate each line with `ExternalStatusSnapshotSchema`, cap an unfinished line at 1 MiB + 1 byte,
check the returned machine against the configured peer and retain the provider UUID. EOF, invalid
data or transport failure invalidates only that host; reconnect with bounded backoff and consume
a fresh baseline. The 5-second evidence lease remains authoritative even before SSH declares a
dead connection. Consumer cancellation must close its SSH process and pipes. No remote-only route
or automatic aggregate fleet API is claimed by this change; consumers without an existing SSH
route need a transport contract from their transport owner. Local readers never wait for remote
hosts. Aggregation and rendering are consumer responsibilities.

# Verification and rollback

`test/external-resident.test.ts` uses real native WebSocket and CCMux HTTP Unix sockets. It covers
100 concurrent reads without source work, event/list races, approval/input states, unknown flags,
expiry, absent/invalid sources, cancelled passes, changed roots, reconnect generations, independent
hosts, bounded/coalescing queues and real daemon restart while the provider survives.
`test/control-client-bundle.test.ts` verifies the published asset offline, both read surfaces and
both stream types through 33 successive cancellation/reconnect cycles each.

The opt-in `bun scripts/external-resident-e2e.ts --run` uses an accessible existing provider and
the installed control API. It creates only two read-only test threads, proves working/idle split,
completion, interruption, stream delivery and consumer reconnect, then archives its own threads.
It consumes provider usage. `--source` substitutes an isolated candidate control listener/observer
without changing the installed daemon. Existing Desktop identities require a separate read-only
comparison; these test threads do not establish coverage of an inaccessible Desktop runtime.

Rollback to the preceding release removes these two read surfaces without changing managed
registries, chat journals, provider UUIDs, external histories or provider launch configuration.
Consumers must treat an unsupported endpoint as unavailable, not fall back to activity-based state.
