import type { z } from 'zod';
import { ROLE_SIGIL } from '../chat/roleAddress.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { fleetAnswer } from '../fleet/fleetList.ts';
import type { FleetMachine, RemoteSessionSchema } from '../fleet/fleetSchema.ts';
import { stateCell } from '../inventory/rows.ts';
import { vendorGlyph } from '../inventory/vendor.ts';
import { machineProfiles } from '../quota/view.ts';
import { loadSessions } from '../session/registry.ts';
import { printLine } from '../util/stdout.ts';
import { alignedLines } from '../util/table.ts';
import { accountLines } from './accounts.ts';
import { COMMAND_SCHEMAS } from './answerSchemas.ts';
import { parseFlags } from './flags.ts';

/** `ccmux fleet` — prints what `fleet/fleetList.ts` answers. */

/** One session's cells on the fleet map. The role and the restart mark ride on the last cell, not in
 *  columns of their own: they belong to the answer "which of these do I write to", read on the line
 *  people copy the address from. */
function fleetSessionCells(
  machine: string,
  session: z.infer<typeof RemoteSessionSchema>,
): string[] {
  // `⟳ ?`: this reader could not tell what a restart would change — not "nothing", not "stale".
  const restart =
    session.stale.length > 0
      ? `  ⟳ ${session.stale.join(',')}`
      : session.staleUnknown !== null
        ? '  ⟳ ?'
        : '';
  const role = session.role === null ? '' : `  ${ROLE_SIGIL}${session.role}`;
  return [
    `  ${machine}:${session.name}`,
    session.agent ?? 'unknown',
    stateCell(session.state, session.atPrompt),
    `${vendorGlyph(session.modelId ?? session.model)} ${session.model ?? '-'}`,
    `${session.uptime?.text ?? ''}${role}${restart}`,
  ];
}

/** One machine's sessions, aligned as a block under its heading. */
export function fleetSessionLines(
  machine: string,
  sessions: readonly z.infer<typeof RemoteSessionSchema>[],
): string[] {
  return alignedLines(sessions.map((session) => fleetSessionCells(machine, session)));
}

/** A single session's line — the block of one. */
export function formatFleetSession(
  machine: string,
  session: z.infer<typeof RemoteSessionSchema>,
): string {
  return fleetSessionLines(machine, [session])[0] as string;
}

/**
 * Why a session is blocked, on the line under it.
 *
 * `blocked` alone sends a reader to the machine to find out; the peer already knows and now says so.
 * Empty for every healthy session, so the map stays a map.
 */
/**
 * The one line under a machine's version, and which of four states it names: behind, current,
 * nobody has been able to check, and nobody is checking any more.
 *
 * The last one comes FIRST because it is the same evidence read two ways, and "behind" is the
 * reassuring reading. A machine whose supervisor died keeps its state files, so it keeps reporting
 * a version and a successful last check; all that happens is that it drifts a patch behind and
 * stays there. That is indistinguishable from a machine mid-update — except that one fixes itself
 * in minutes and the other never does, because the process that would fix it is the process that is
 * gone. Drawn as "a patch behind", a fleet ran unsupervised for two hours and the view said
 * something mild the whole time.
 */
export function machineStanding(fm: FleetMachine): string {
  if (fm.release?.checksOverdue === true) {
    const at = fm.release.checkedAt?.slice(0, 16).replace('T', ' ') ?? 'unknown';
    return `  ⟵ nothing has checked since ${at} — is its daemon running?`;
  }
  if (fm.behind !== null) return `  ⟵ ${fm.behind} behind`;
  if (fm.release === null || fm.release.latest === null) return '  (release unknown here)';
  return fm.release.ok ? '' : '  (cannot reach the release feed — this is what it knew)';
}

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
  const flags = parseFlags('fleet', args, [0, 0]);
  if (flags.bool('schema')) {
    await printLine(JSON.stringify(COMMAND_SCHEMAS.fleet()));
    return 0;
  }
  const m = loadMachineConfig();
  const answer = await fleetAnswer(m);
  if (flags.bool('json')) {
    await printLine(JSON.stringify(answer));
    return 0;
  }
  const view = answer;
  const { machines } = answer;
  if (machines.length === 1) {
    console.log(
      '(no peers configured in machine.json — add a "fleet" map or "remoteTransport.peers" — showing this machine only)',
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
        : fm.alias === 'remote'
          ? `${fm.machine} via remote adapter`
          : fm.fallback !== null
            ? `${fm.machine} → ${fm.alias} (ssh fallback: ${fm.fallback})`
            : `${fm.machine} → ${fm.alias}`;
    if (!fm.ok) {
      console.log(`${label}: ${fm.error}`);
      continue;
    }
    const standing = machineStanding(fm);
    console.log(`${label}  [ccmux ${fm.version}]${standing}`);
    const { shown, parked } = partitionParked(fm.sessions, flags.bool('all'));
    // Full address on every line — the thing you copy into `ccmux msg` without guessing. A session
    // that a restart would change is flagged right here, so "who is still on the old prompt" is
    // readable across the fleet instead of remembered.
    const lines = fleetSessionLines(fm.machine, shown);
    for (const [index, s] of shown.entries()) {
      await printLine(lines[index] as string);
      const detail = fleetSessionDetail(s);
      if (detail !== null) await printLine(detail);
    }
    if (parked > 0) console.log(`  … ${parked} archived (ccmux fleet --all)`);
  }
  for (const line of accountLines(view.machines, Date.now(), machineProfiles(m, loadSessions(m))))
    console.log(line);
  return 0; // unreachable machines are routine, never a failure exit
}
