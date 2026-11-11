import { z } from 'zod';
import { readInventory } from '../events/inventory.ts';
import { InventorySnapshotSchema } from '../events/schema.ts';
import { ReleaseStandingSchema } from '../inventory/listSchema.ts';
import { collectRows, rowStateLabel, toListItem } from '../inventory/rows.ts';
import { machineProfiles } from '../quota/view.ts';
import { behindBy, bestKnownRelease, releaseStanding } from '../release/check.ts';
import { loadSessions } from '../session/registry.ts';
import type { MachineConfig } from '../types.ts';
import { VERSION } from '../util/version.ts';
import { fleetAccounts } from './accounts.ts';
import {
  type FleetAnswer,
  type FleetMachine,
  type FleetView,
  RemoteSessionSchema,
} from './fleetSchema.ts';
import { loadPeerHeld, type Packed, PackedSchema, type PeerHeld, unpack } from './peerDelta.ts';
import { peersOf, type RemoteResult, remoteFailureCause, runPeer } from './transport.ts';

/**
 * Every session on every machine of the fleet, in one answer.
 *
 * Besides being the obvious "where is everything", this is what makes the homonym mine visible: you
 * see at a glance that `api` lives on host-a while host-b has its own similarly-named session, which
 * is precisely the confusion that mis-delivered a report in the 2026-08-05 incident.
 *
 * Deliberately LENIENT about what a remote returns: another box may run an older ccmux whose
 * `list --json` has a different shape, so we parse only the few fields we display. A missing agent
 * becomes explicit `unknown`; silently calling it Claude would turn version skew into misrouting.
 * And "unreachable" is a NORMAL result, not a failure — with no server-side keys, transit
 * between two servers only exists while the owner is connected — so the command still exits 0 and
 * simply marks that machine, instead of an agent reading routine degradation as an error.
 */
const RemoteListSchema = z.object({
  version: z.string().default('?'),
  rcPrefix: z.string().default('?'),
  // Absent from a peer too old to report it, which reads as "not known" rather than "up to date" —
  // exactly the distinction the block itself exists to keep.
  release: ReleaseStandingSchema.nullable().default(null),
  sessions: z.array(RemoteSessionSchema).default([]),
  // A peer too old to publish one says nothing, and an unreadable one costs only itself.
  inventory: InventorySnapshotSchema.nullable().default(null).catch(null),
});

/** A peer's `_peer-read list` envelope: the two row arrays arrive packed (see `peerDelta.ts`). */
const DeltaListSchema = z
  .object({
    sessions: PackedSchema,
    inventory: z.object({ sessions: PackedSchema }).loose().nullable().default(null).catch(null),
  })
  .loose();

/**
 * A peer's delta answer as the full `list --json` it stands for, plus the packs that name the rows
 * to keep; null when it is not a delta answer or refers to a row this reader never held.
 */
export function expandPeerList(
  raw: unknown,
  held: Readonly<Record<string, unknown>>,
): { answer: unknown; packs: Packed[] } | null {
  const delta = DeltaListSchema.safeParse(raw).data;
  if (delta === undefined) return null;
  const sessions = unpack(delta.sessions, held, (stable, uptime) => ({
    ...(stable as object),
    uptime,
  }));
  if (sessions === null) return null;
  const inventoryRows = delta.inventory === null ? null : unpack(delta.inventory.sessions, held);
  return {
    answer: {
      ...delta,
      sessions,
      inventory:
        delta.inventory === null || inventoryRows === null
          ? null
          : { ...delta.inventory, sessions: inventoryRows },
    },
    packs: delta.inventory === null ? [delta.sessions] : [delta.sessions, delta.inventory.sessions],
  };
}

/** Query every machine in parallel; each failure is contained to its own row. */
export async function collectFleet(m: MachineConfig): Promise<FleetMachine[]> {
  // This machine's rows are built WHILE the peers answer, not before they are asked: awaited first,
  // the local pass sat in front of every remote round trip and the answer took both, one after the
  // other.
  const [local, remote] = await Promise.all([collectRows(m), collectPeers(m)]);
  const self: FleetMachine = {
    machine: m.rcPrefix,
    alias: null,
    ok: true,
    error: null,
    version: VERSION,
    release: releaseStanding(m, VERSION),
    behind: null, // filled by `fleetView`, which is the only place that holds the yardstick
    inventory: readInventory(m),
    fallback: null,
    // This machine's own rows, built by the same function that builds `list --json`. Two builders
    // for one row is what made a field arrive locally and vanish remotely for a release at a time;
    // the fleet view simply relabels the state, which is the only thing it says differently.
    sessions: local.map((r) => ({
      ...toListItem(m, r),
      state: rowStateLabel(r.state, r.running, r.session.archived),
      uptime: { text: r.running ? r.uptimeText : null, seconds: r.uptimeSeconds },
    })),
  };
  return [self, ...remote];
}

/** Every peer asked at once; each failure is contained to its own row. */
function collectPeers(m: MachineConfig): Promise<FleetMachine[]> {
  return Promise.all(
    peersOf(m).map(async ({ machine, alias, via }): Promise<FleetMachine> => {
      // Asked by change: the rows this reader already holds come back as digests, which is what
      // keeps a fleet read every few seconds from being the largest flow off the servers.
      const held = loadPeerHeld(machine, 'list');
      const argv = ['ccmux', '_peer-read', 'list', ...held.knownArgs];
      const r = await runPeer(m, machine, alias, argv, {
        // The execution budget stays generous — a busy machine listing many sessions is answering,
        // not absent. The DIAL is what gets cut: this view asks every machine at once and has a
        // cell for "not reachable right now", so waiting out one machine's full connect attempt
        // costs every other row its freshness. Measured with one machine down: eleven seconds to a
        // complete answer whose data was ready in two, and a consumer with a twelve-second bound
        // lost the whole inventory on the toss of a coin.
        timeoutMs: 20_000,
        connectTimeoutSeconds: 3,
      });
      // The row names the path the answer actually took: a fallback came over ssh.
      return peerListMachine(machine, via === 'remote' && !r.fallback ? 'remote' : alias, r, held);
    }),
  );
}

/**
 * One peer's `_peer-read list` answer, as the row the fleet view draws for that machine.
 *
 * Every way the answer can fail keeps its own sentence: the transport's own detail, the remote
 * command's first error line with its exit code, or output this version cannot read. A machine that
 * failed is never drawn as an empty one.
 */
export function peerListMachine(
  machine: string,
  alias: string | null,
  r: RemoteResult,
  held?: PeerHeld,
): FleetMachine {
  const failed = (error: string): FleetMachine => ({
    machine,
    alias,
    ok: false,
    error,
    version: '?',
    release: null,
    behind: null,
    sessions: [],
    inventory: null,
    fallback: r.fallback ?? null,
  });
  if (r.transportFailed) return failed(r.failureDetail ?? 'unreachable (no transit right now)');
  if (r.code !== 0)
    return failed(
      `remote ccmux failed (exit ${r.code}): ${remoteFailureCause(r.stderr) ?? 'no reason reported'}`,
    );
  let parsed: z.infer<typeof RemoteListSchema> | undefined;
  let expanded: ReturnType<typeof expandPeerList> = null;
  try {
    expanded = expandPeerList(JSON.parse(r.stdout), held?.rows ?? {});
    parsed = expanded === null ? undefined : RemoteListSchema.safeParse(expanded.answer).data;
  } catch {
    parsed = undefined;
  }
  if (expanded === null || parsed === undefined)
    return failed('unreadable list output (older ccmux?)');
  held?.save(expanded.packs);
  return {
    machine,
    alias,
    ok: true,
    error: null,
    version: parsed.version,
    release: parsed.release,
    behind: null,
    inventory: parsed.inventory,
    fallback: r.fallback ?? null,
    // A peer reports its raw run-state; the parked/running verdict is reached here so both
    // halves of the map are read by the same rule.
    sessions: parsed.sessions.map((session) => ({
      ...session,
      state: rowStateLabel(session.state, session.running, session.archived),
    })),
  };
}

/**
 * One yardstick for the whole answer.
 *
 * The best-known release is taken across every machine that could report one, and every machine is
 * then measured against THAT. It is the difference between a fleet view that tells you a
 * disconnected box is fine and one that tells you it is four minors behind and has not been able to
 * check for a day.
 */
export function fleetView(machines: FleetMachine[]): FleetView {
  const latest = bestKnownRelease(machines.map((x) => x.release?.latest ?? null));
  const latestAt =
    machines.find((x) => x.release?.latest === latest && x.release?.latestAt != null)?.release
      ?.latestAt ?? null;
  return {
    latest,
    latestAt,
    machines: machines.map((x) => ({
      ...x,
      behind: x.release === null ? null : behindBy(x.release.current, latest),
    })),
  };
}

/** Every machine's sessions and the accounts they spend on, as one answer. */
export async function fleetAnswer(m: MachineConfig): Promise<FleetAnswer> {
  const view = fleetView(await collectFleet(m));
  const now = Date.now();
  return {
    version: VERSION,
    generatedAt: new Date(now).toISOString(),
    ...view,
    // `now` is the response's own clock: whether a window has ended and whether a sample is stale
    // are true at READ time, so they are computed here and never stored.
    accounts: fleetAccounts(view.machines, now, machineProfiles(m, loadSessions(m))),
  };
}
