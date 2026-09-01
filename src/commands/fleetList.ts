import { z } from 'zod';
import { ROLE_SIGIL } from '../chat/roleAddress.ts';
import { loadMachineConfig } from '../config/machine.ts';
import {
  type BehindBy,
  behindBy,
  bestKnownRelease,
  releaseStanding,
} from '../config/releaseCheck.ts';
import { AgentKindSchema, ContextInfoSchema, ReleaseStandingSchema } from '../config/schema.ts';
import { peersOf, runPeer } from '../fleet/transport.ts';
import { PlanLimitsSchema } from '../runtime/planLimits.ts';
import { NativeAccountSchema } from '../runtime/projectionSchema.ts';
import type { MachineConfig, ReleaseStanding } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';
import { accountLines, fleetAccounts } from './accounts.ts';
import { collectRows, rowStateLabel } from './list.ts';

/**
 * `ccmux fleet` — every session on every machine of the fleet, in one view.
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
export const RemoteSessionSchema = z.object({
  name: z.string(),
  agent: AgentKindSchema.nullable().default(null),
  state: z.string().default('?'),
  /** Absent on a peer running an older ccmux, where `false` reproduces the previous reading. */
  archived: z.boolean().default(false),
  model: z.string().nullable().default(null),
  running: z.boolean().default(false),
  stale: z.array(z.string()).default([]),
  /**
   * The session's declared execution directory, carried through unchanged by fleet transport.
   * It need not be a Git checkout and proves neither repository identity nor product membership.
   * Several exact session identities may share it. A path prefix, dependency or harness project
   * label is not membership authority; any explicit many-to-many product/repository catalogue
   * belongs to the consumer. Routing uses the managed address and pinned native identity.
   *
   * Null from a peer too old to report it — which is a peer whose other sessions still arrive.
   */
  dir: z.string().nullable().default(null),
  // What that session is FOR. Shown on the address line, because a role that a reader has to go and
  // look up is not consulted at the moment an address is chosen — which is the moment it exists for.
  role: z.string().nullable().default(null),
  // Absent on a peer running an older ccmux, which is exactly what `null` means here: not "that
  // session is idle" but "that build does not report it". `version` is on the machine row beside it,
  // so a consumer can tell the two apart without guessing.
  turnStartedAt: z.string().nullable().default(null),
  /**
   * Who that session is waiting for. Null on a peer too old to report it, exactly as above — not
   * "that session is waiting for nobody" but "that build does not say". Defaulted rather than
   * required so one un-upgraded peer cannot fail the parse of every row in the fleet.
   */
  waitingFor: z.string().nullable().default(null),
  /**
   * Where the session stopped, as `list --json` already reports it locally.
   *
   * Busy is visible from the timer; WHAT it is busy with is not, and a reader watching the whole
   * fleet only ever takes the fleet path. Null from a peer too old to report it — which is not the
   * same as a session with nothing to show, the distinction already drawn for `turnStartedAt`.
   *
   * Parsed loosely on purpose: this schema names what it displays, and the transcript shape grows
   * fields faster than a fleet of mixed builds adopts them.
   */
  lastMessage: z
    .object({
      kind: z.string().default('unknown'),
      role: z.string().default('unknown'),
      text: z.string().nullable().default(null),
      toolName: z.string().nullable().default(null),
      createdAt: z.string().nullable().default(null),
    })
    .loose()
    .nullable()
    .default(null),
  uptime: z
    .object({ text: z.string().nullable().default(null) })
    .partial()
    .optional(),
  /**
   * Context-window fill, as `list --json` already reports it locally.
   *
   * Dropped here before: the peer sent it and this schema did not name it, so a consumer watching
   * the whole fleet — which must go through `fleet`, one call for every machine — could read
   * context fill for local sessions only. The default is the "nothing measured" shape, which is
   * also what an older peer's silence means.
   */
  context: ContextInfoSchema.default(() => ({
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
    rawLimitTokens: null,
    window: null,
  })),
  /**
   * Which account this session runs on and what it has spent.
   *
   * The reason it travels: a limit belongs to an account, not to a machine, so the only place the
   * question "which sessions share this one" can be answered is the slice that spans every machine.
   * An older peer reports nothing, which is not the same as running on no account.
   */
  account: NativeAccountSchema.nullable().default(null),
  /**
   * How much of that account's plan is used, as the peer measured it.
   *
   * It travels for the same reason `account` does, one step further: knowing which sessions share a
   * plan is only half the question an operator asks before a limit stops the work. An older peer
   * reports nothing, which is not the same as an account with room to spare.
   */
  planLimits: PlanLimitsSchema.nullable().default(null),
  costUsd: z.number().nullable().default(null),
});
const RemoteListSchema = z.object({
  version: z.string().default('?'),
  rcPrefix: z.string().default('?'),
  // Absent from a peer too old to report it, which reads as "not known" rather than "up to date" —
  // exactly the distinction the block itself exists to keep.
  release: ReleaseStandingSchema.nullable().default(null),
  sessions: z.array(RemoteSessionSchema).default([]),
});

export interface FleetMachine {
  machine: string;
  alias: string | null; // null = this machine
  ok: boolean;
  error: string | null;
  version: string;
  /** Facts that machine reports about ITSELF: what is installed, what it last managed to read from
   *  the release feed, when it last tried and whether that worked. Null from an older peer. */
  release: ReleaseStanding | null;
  /**
   * How far behind it is — measured against the best release ANY machine here knows, never against
   * its own memory.
   *
   * A machine that lost its route to the release feed remembers an old "latest", and judging it by
   * that memory reports it as less behind than it is, sometimes as up to date. The error would point
   * in the reassuring direction, in exactly the case someone is looking because something seems
   * wrong. Null means level, ahead, or nothing to measure against.
   */
  behind: BehindBy;
  sessions: z.infer<typeof RemoteSessionSchema>[];
}

/** The fleet's answer, with ONE yardstick for the whole of it. */
export interface FleetView {
  /** The newest release any machine here has managed to read. Null when none of them knows. */
  latest: string | null;
  /** When that release was published, from whichever machine read it. Null if unknown. */
  latestAt: string | null;
  machines: FleetMachine[];
}

/** Query every machine in parallel; each failure is contained to its own row. */
export async function collectFleet(m: MachineConfig): Promise<FleetMachine[]> {
  const local = await collectRows(m);
  const self: FleetMachine = {
    machine: m.rcPrefix,
    alias: null,
    ok: true,
    error: null,
    version: VERSION,
    release: releaseStanding(m, VERSION),
    behind: null, // filled by `fleetView`, which is the only place that holds the yardstick
    sessions: local.map((r) => ({
      name: r.session.name,
      agent: r.session.agent,
      state: rowStateLabel(r.state, r.running, r.session.archived),
      archived: r.session.archived,
      model: r.model,
      running: r.running,
      uptime: { text: r.uptimeText },
      waitingFor: r.waitingFor,
      lastMessage: r.lastMessage,
      stale: r.stale,
      dir: r.session.dir,
      role: r.session.role ?? null,
      turnStartedAt: r.turnStartedAt,
      context: r.context,
      account: r.account,
      planLimits: r.planLimits,
      costUsd: r.costUsd,
    })),
  };
  const remote = await Promise.all(
    peersOf(m).map(async ({ machine, alias, via }): Promise<FleetMachine> => {
      const r = await runPeer(m, machine, alias, ['ccmux', 'list', '--json'], {
        timeoutMs: 20_000,
      });
      const label = via === 'wire' ? 'wire' : alias;
      if (r.transportFailed) {
        return {
          machine,
          alias: label,
          ok: false,
          error: r.failureDetail ?? 'unreachable (no transit right now)',
          version: '?',
          release: null,
          behind: null,
          sessions: [],
        };
      }
      if (r.code !== 0)
        return {
          machine,
          alias: label,
          ok: false,
          error: `remote ccmux failed (exit ${r.code})`,
          version: '?',
          release: null,
          behind: null,
          sessions: [],
        };
      try {
        const parsed = RemoteListSchema.safeParse(JSON.parse(r.stdout)).data;
        if (parsed === undefined)
          return {
            machine,
            alias: label,
            ok: false,
            error: 'unreadable list output (older ccmux?)',
            version: '?',
            release: null,
            behind: null,
            sessions: [],
          };
        return {
          machine,
          alias: label,
          ok: true,
          error: null,
          version: parsed.version,
          release: parsed.release,
          behind: null,
          // A peer reports its raw run-state; the parked/running verdict is reached here so both
          // halves of the map are read by the same rule.
          sessions: parsed.sessions.map((session) => ({
            ...session,
            state: rowStateLabel(session.state, session.running, session.archived),
          })),
        };
      } catch {
        return {
          machine,
          alias: label,
          ok: false,
          error: 'unreadable list output (older ccmux?)',
          version: '?',
          release: null,
          behind: null,
          sessions: [],
        };
      }
    }),
  );
  return [self, ...remote];
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

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function formatFleetSession(
  machine: string,
  session: z.infer<typeof RemoteSessionSchema>,
): string {
  const restart = session.stale.length > 0 ? `  ⟳ ${session.stale.join(',')}` : '';
  const agent = session.agent ?? 'unknown';
  // The role rides on the ADDRESS line, not in a column of its own, because it is part of the answer
  // to "which of these do I write to" — and the line above is the one people copy from.
  const role = session.role === null ? '' : `  ${ROLE_SIGIL}${session.role}`;
  return `  ${pad(`${machine}:${session.name}`, 28)} ${pad(agent, 8)} ${pad(session.state, 9)} ${pad(session.model ?? '-', 11)} ${pad(session.uptime?.text ?? '', 7)}${role}${restart}`;
}

/**
 * Parked rows are counted, never silently dropped.
 *
 * An archived session is one somebody deliberately took out of service, and on a machine that runs
 * control-plane exercises they outnumber the live ones several times over. Printing them beside
 * working sessions turns the map into a list of things that are not happening. Hiding them outright
 * would be the other lie, so the count stays on screen with the flag that brings them back.
 */
export function partitionParked<T extends { archived: boolean }>(
  sessions: readonly T[],
  all: boolean,
): { shown: readonly T[]; parked: number } {
  if (all) return { shown: sessions, parked: 0 };
  const shown = sessions.filter((session) => !session.archived);
  return { shown, parked: sessions.length - shown.length };
}

export async function cmdFleet(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const machines = await collectFleet(m);
  const view = fleetView(machines);
  if (args.includes('--json')) {
    await printLine(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        ...view,
        // Aggregated here rather than left to each consumer: the grouping is the answer, and every
        // reader recomputing it from sessions would eventually disagree about the same fleet.
        accounts: fleetAccounts(view.machines),
      }),
    );
    return 0;
  }
  if (machines.length === 1) {
    console.log(
      '(no peers configured in machine.json — add a "fleet" map or "wire.peers" — showing this machine only)',
    );
  }
  if (view.latest !== null)
    console.log(
      `latest release: ccmux ${view.latest}${view.latestAt === null ? '' : ` (${view.latestAt.slice(0, 10)})`}`,
    );
  for (const fm of view.machines) {
    const label =
      fm.alias === null
        ? `${fm.machine} (this machine)`
        : fm.alias === 'wire'
          ? `${fm.machine} via wire`
          : `${fm.machine} → ${fm.alias}`;
    if (!fm.ok) {
      console.log(`${label}: ${fm.error}`);
      continue;
    }
    // Three states, and the third is the one a bare version number hides: behind, current, or
    // nobody has been able to check — which must never be drawn as current.
    const standing =
      fm.behind !== null
        ? `  ⟵ ${fm.behind} behind`
        : fm.release === null || fm.release.latest === null
          ? '  (release unknown here)'
          : fm.release.ok
            ? ''
            : '  (cannot reach the release feed — this is what it knew)';
    console.log(`${label}  [ccmux ${fm.version}]${standing}`);
    const { shown, parked } = partitionParked(fm.sessions, args.includes('--all'));
    for (const s of shown) {
      // Full address on every line — the thing you copy into `ccmux msg` without guessing.
      // A session that a restart would change is flagged right here, so "who is still on the old
      // prompt" is readable across the fleet instead of remembered.
      console.log(formatFleetSession(fm.machine, s));
    }
    if (parked > 0) console.log(`  … ${parked} archived (ccmux fleet --all)`);
  }
  for (const line of accountLines(view.machines)) console.log(line);
  return 0; // unreachable machines are routine, never a failure exit
}

export { type FleetAccount, fleetAccounts } from './accounts.ts';
export { accountLines };
