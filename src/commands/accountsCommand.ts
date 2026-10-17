import { loadMachineConfig } from '../config/machine.ts';
import { collectRows } from '../inventory/rows.ts';
import { refreshQuota } from '../quota/refresh.ts';
import { machineProfiles, type ProfileView } from '../quota/view.ts';
import { loadSessions } from '../session/registry.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';
import { accountLines, fleetAccounts } from './accounts.ts';
import { parseFlags } from './flags.ts';
import { collectFleet, fleetView } from './fleetList.ts';

/** A profile the quota layer found but could not name an account for, or could not read. */
interface AccountProblem {
  machine: string;
  profile: string;
  provider: 'claude' | 'codex';
  /** Why: the newest probe's error, or that nothing has asked yet. */
  reason: string;
}

function problemsOf(machine: string, views: readonly ProfileView[]): AccountProblem[] {
  const out: AccountProblem[] = [];
  for (const view of views) {
    if (view.account !== null && view.error === null) continue;
    out.push({
      machine,
      profile: view.home ?? 'default',
      provider: view.provider,
      reason:
        view.error ??
        (view.attemptedAt === null
          ? 'no probe has read this profile yet'
          : 'the probe did not name an account'),
    });
  }
  return out;
}

/**
 * `ccmux accounts` — every signed-in account in one answer.
 *
 * The same grouping `fleet` prints under its sessions, asked for on its own: Claude and Codex
 * accounts across the fleet, each with its plan windows, the source of every number and its age,
 * and the profiles on this machine that no session runs under. `--refresh` asks the vendors now.
 */
export async function cmdAccounts(args: string[] = []): Promise<number> {
  const flags = parseFlags('accounts', args, [0, 0]);
  const m = loadMachineConfig();
  const sessions = loadSessions(m);
  if (flags.bool('refresh')) await refreshQuota(m, sessions, { force: true });
  const profiles = machineProfiles(m, sessions);
  const machines = flags.bool('local')
    ? [
        {
          machine: m.rcPrefix,
          sessions: (await collectRows(m)).map((r) => ({
            name: r.session.name,
            account: r.account,
            costUsd: r.costUsd,
            planLimits: r.planLimits,
          })),
        },
      ]
    : fleetView(await collectFleet(m)).machines;
  const now = Date.now();
  const accounts = fleetAccounts(machines, now, profiles);
  const problems = problemsOf(
    m.rcPrefix,
    profiles.map((p) => p.view),
  );
  if (flags.bool('json')) {
    await printLine(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date(now).toISOString(),
        accounts,
        problems,
      }),
    );
    return 0;
  }
  const lines = accountLines(machines, now, profiles);
  if (lines.length === 0) console.log('no signed-in account found');
  for (const line of lines) console.log(line);
  for (const p of problems)
    console.log(`  ${p.machine}: ${p.provider} profile ${p.profile} — ${p.reason}`);
  return 0;
}
