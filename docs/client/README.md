# @stitchmux/client

The Stitchmux client: typed control of Stitchmux sessions and monitoring snapshots (ESM, TypeScript
declarations included). `zod` and `stitchkit` are peer dependencies — the client takes and returns
their schemas and contracts.

| Entry | What | Runs in |
|---|---|---|
| `@stitchmux/client` | `controlContract`, every schema, `refusals`, `createInjectedControlClient` | a browser, Bun, Node.js — loading it runs no Node code |
| `@stitchmux/client/socket` | `createControlClient` over the local daemon's socket | Bun, Node.js |
| `@stitchmux/client/monitoring` | `readMonitoringStatus` and the snapshot schemas | Bun, Node.js |

```sh
bun add @stitchmux/client zod stitchkit
```

## Control over the local daemon

On the machine running Stitchmux, connect to its daemon's socket:

```ts
import { createControlClient } from '@stitchmux/client/socket';

const client = createControlClient({ socket: '/path/to/control/api.sock' });
const fleet = await client['fleet.list']({});
await client.close();
```

## Control over your own transport

From another machine or service, run the same operations over a transport you supply — for
example a Stitchwire service caller. The function receives the operation's URL and request, and
returns its `Response`:

```ts
import { createInjectedControlClient } from '@stitchmux/client';

const client = createInjectedControlClient((url, init) => myTransport(url, init));
const directory = await client['directory.list']({ path: '/srv' });
```

Every operation and its schemas are in `controlContract`; each refusal a call can return is in
`refusals`, with its code, HTTP status and whether a retry can succeed.

## Monitoring snapshots

```ts
import { MonitoringSnapshotReadSchema, readMonitoringStatus } from '@stitchmux/client/monitoring';
```

The read schema accepts snapshots from newer Stitchmux releases: a value it does not know reads as
`unknown` instead of failing the whole snapshot.
