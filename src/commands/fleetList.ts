import { z } from 'zod';
import { ROLE_SIGIL } from '../chat/roleAddress.ts';
import { loadMachineConfig } from '../config/machine.ts';
import {
  type BehindBy,
  behindBy,
  bestKnownRelease,
  releaseStanding,
} from '../config/releaseCheck.ts';
import {
  AgentKindSchema,
  ContextInfoSchema,
  ListItemSchema,
  ReleaseStandingSchema,
  TranscriptMessageSchema,
} from '../config/schema.ts';
import { peersOf, runPeer } from '../fleet/transport.ts';
import type { MachineConfig, ReleaseStanding } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';
import { accountLines, fleetAccounts } from './accounts.ts';
import { collectRows, rowStateLabel, toListItem } from './list.ts';

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
/**
 * A peer's session row: the same row `list --json` produces, read leniently.
 *
 * Derived rather than restated. The subset that used to live here had to gain every field the local
 * answer gained, and until it did the field was silently absent for every remote session — which
 * reads as "nothing to show" when the truth is "this schema stopped listening". A field added to the
 * local row with its own "not reported" default now arrives here by construction.
 *
 * What is overridden is only what a peer may legitimately not have, or may have differently:
 * another box can run an older or a newer build, and one un-upgraded peer must not fail the parse of
 * every row in the fleet. Unknown keys are kept rather than stripped, so a newer peer's field
 * reaches a consumer that already understands it.
 */
export const RemoteSessionSchema = ListItemSchema.extend({
  // Required locally, because a local answer must state the provider rather than let anyone infer
  // it from model, cwd or name. From a peer, absence is `unknown` — never Claude, which would turn
  // version skew into misrouting.
  agent: AgentKindSchema.nullable().default(null),
  // A state this build does not know is still a state the peer is in: read as text, not as an enum
  // that would reject the whole row.
  state: z.string().default('?'),
  running: z.boolean().default(false),
  archived: z.boolean().default(false),
  dir: z.string().nullable().default(null),
  // Identity fields the fleet view does not address by: absent from an older peer rather than empty.
  uuid: z.string().nullable().default(null),
  rc: z.string().nullable().default(null),
  lifecycleError: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  // Loosely on purpose: the transcript shape grows fields faster than a fleet of mixed builds
  // adopts them, and a row is worth more than the newest field is worth rejecting it over.
  // Every field optional and unknown keys kept: the transcript shape grows faster than a fleet of
  // mixed builds adopts it, and a row is worth more than the newest field is worth rejecting it over.
  lastMessage: TranscriptMessageSchema.partial()
    .extend({
      // Read as text, not as this build's enums: a newer peer may name a kind, a role or a status
      // this one has never heard of, and rejecting the row would cost the whole message rather than
      // the one word nobody here understands.
      kind: z.string().optional(),
      role: z.string().optional(),
      status: z.string().nullish(),
    })
    .loose()
    .nullable()
    .default(null),
  uptime: z
    .object({
      text: z.string().nullable().default(null),
      seconds: z.number().nullable().default(null),
    })
    .default(() => ({ text: null, seconds: null })),
  // The "nothing measured" shape, which is also what an older peer's silence means.
  context: ContextInfoSchema.default(() => ({
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
    rawLimitTokens: null,
    window: null,
  })),
}).loose();

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
    // This machine's own rows, built by the same function that builds `list --json`. Two builders
    // for one row is what made a field arrive locally and vanish remotely for a release at a time;
    // the fleet view simply relabels the state, which is the only thing it says differently.
    sessions: local.map((r) => ({
      ...toListItem(m, r),
      state: rowStateLabel(r.state, r.running, r.session.archived),
      uptime: { text: r.running ? r.uptimeText : null, seconds: r.uptimeSeconds },
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
  // A session sitting at a menu reads as idle from every other signal — still pane, no tool running
  // — when it is the opposite: unable to proceed until somebody answers. It travels now, so it is
  // shown, in the state column where a reader is already looking.
  const state = session.atPrompt === null ? session.state : session.atPrompt;
  return `  ${pad(`${machine}:${session.name}`, 28)} ${pad(agent, 8)} ${pad(state, 13)} ${pad(session.model ?? '-', 11)} ${pad(session.uptime?.text ?? '', 7)}${role}${restart}`;
}

/**
 * Why a session is blocked, on the line under it.
 *
 * `blocked` alone sends a reader to the machine to find out; the peer already knows and now says so.
 * Empty for every healthy session, so the map stays a map.
 */
export function fleetSessionDetail(session: z.infer<typeof RemoteSessionSchema>): string | null {
  return session.lifecycleError === null ? null : `      ${session.lifecycleError}`;
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
      await printLine(formatFleetSession(fm.machine, s));
      const detail = fleetSessionDetail(s);
      if (detail !== null) await printLine(detail);
    }
    if (parked > 0) console.log(`  … ${parked} archived (ccmux fleet --all)`);
  }
  for (const line of accountLines(view.machines)) console.log(line);
  return 0; // unreachable machines are routine, never a failure exit
}

export { type FleetAccount, fleetAccounts } from './accounts.ts';
export { accountLines };
