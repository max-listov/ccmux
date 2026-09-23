import { loadMachineConfig, rcName } from '../config/machine.ts';
import { readInventory } from '../events/inventory.ts';
import {
  collectRows,
  envFileEntry,
  type ListRow,
  rowStateLabel,
  stateCell,
  toListItem,
} from '../inventory/rows.ts';
import { vendorGlyph } from '../inventory/vendor.ts';
import { releaseStanding } from '../release/check.ts';
import type { ListJson, MachineConfig } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { VERSION } from '../util/version.ts';
import { accountLines } from './accounts.ts';
import { parseFlags } from './flags.ts';

function printTable(m: MachineConfig, rows: ListRow[]): void {
  const lines = tableLines(
    ['SESSION', 'AGENT', 'MODEL', 'CTX', 'STATE', 'UPTIME', 'RESTART', 'RC', 'DIR'],
    rows.map((r) => [
      r.session.name,
      r.session.agent,
      `${vendorGlyph(r.modelId ?? r.model)} ${r.model ?? '-'}`,
      r.contextLabel,
      stateCell(rowStateLabel(r.state, r.running, r.session.archived), r.atPrompt),
      r.uptimeText,
      r.stale.length > 0 ? r.stale.join(',') : r.staleUnknown !== null ? '?' : '-',
      rcName(m, r.session.name),
      r.session.dir,
    ]),
  );
  console.log(lines[0]);
  rows.forEach((r, index) => {
    console.log(lines[index + 1]);
    if (r.lifecycleError !== null) console.log(`  blocked: ${r.lifecycleError}`);
    // A declared env file that is not on disk. The session still starts — that was the deliberate
    // choice, since a supervisor whose sessions refuse to boot is worse than one variable short — so
    // this line is the only place a person finds out before wondering why a variable is empty.
    const env = envFileEntry(r.session);
    if (env !== null && !env.present) console.log(`  env file declared but missing: ${env.path}`);
  });
}

async function printJson(m: MachineConfig, rows: ListRow[]): Promise<void> {
  const out: ListJson = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    rcPrefix: m.rcPrefix,
    stateDir: m.stateDir,
    release: releaseStanding(m, VERSION),
    sessions: rows.map((r) => toListItem(m, r)),
    inventory: readInventory(m),
  };
  await printLine(JSON.stringify(out));
}

/** The three fields the account grouping reads, so `list` and `fleet` answer from one implementation. */
const fleetRowSlice = (r: ListRow) => ({
  name: r.session.name,
  account: r.account,
  costUsd: r.costUsd,
  planLimits: r.planLimits,
});

export async function cmdList(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const flags = parseFlags('list', args, [0, 0]);
  const rows = await collectRows(m);
  // `--json` is a machine's answer and stays complete: a consumer filters for itself, and a reader
  // that asked for everything must not be given a view. Only the human table folds.
  if (flags.bool('json')) {
    await printJson(m, rows);
    return 0;
  }
  const all = flags.bool('all');
  const shown = all ? rows : rows.filter((r) => !(r.session.archived && !r.running));
  printTable(m, shown);
  const parked = rows.length - shown.length;
  if (parked > 0) console.log(`… ${parked} archived (ccmux list --all)`);
  // Printed after the table rather than as a column: the plan window belongs to the account, so it
  // is one fact about several rows, and a per-row column would repeat one budget as many.
  for (const line of accountLines(
    [{ machine: m.rcPrefix, sessions: shown.map(fleetRowSlice) } as never],
    Date.now(),
  ))
    console.log(line);
  return 0;
}
