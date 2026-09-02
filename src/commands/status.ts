import { loadMachineConfig } from '../config/machine.ts';
import { readMonitoringStatus } from '../monitoring/read.ts';
import type { MonitoringRow } from '../monitoring/schema.ts';

/** The statusLine's own cost, as a number rather than an impression: it runs per session on every
 *  transcript event, which is the most frequent thing this tool causes a machine to do. Summed from
 *  what the daemon already observed, so this reader still opens exactly one file. */
function renderLine(rows: readonly MonitoringRow[]): string {
  const measured = rows.filter((row) => row.statusLineRendersPerMinute !== null);
  if (measured.length === 0) return 'status-line: not measured yet';
  const total = measured.reduce((sum, row) => sum + (row.statusLineRendersPerMinute ?? 0), 0);
  return `status-line ${total.toFixed(1)} renders/min across ${measured.length} session${measured.length === 1 ? '' : 's'}`;
}

export async function cmdStatus(args: string[]): Promise<number> {
  if (args.some((arg) => arg !== '--json')) {
    console.error('usage: ccmux status [--json]');
    return 1;
  }
  const result = readMonitoringStatus(loadMachineConfig());
  const text = args.includes('--json')
    ? JSON.stringify(result)
    : result.snapshot === null
      ? `status ${result.status}: ${result.reason}`
      : [
          `status live · ${result.snapshot.sessions.length} managed · ${result.snapshot.omitted} omitted`,
          renderLine(result.snapshot.sessions),
          ...result.snapshot.sessions.map(
            (s) => `${s.rc} ${s.agent} ${s.state} ${s.model ?? 'unknown'} ${s.dir}`,
          ),
        ].join('\n');
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve())),
  );
  return result.status === 'live' ? 0 : result.status === 'stale' ? 2 : 3;
}
