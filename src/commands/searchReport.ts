import { loadMachineConfig } from '../config/machine.ts';
import { parseWhen } from '../context/searchFleet.ts';
import type { SearchJournalEntry } from '../context/searchJournal.ts';
import {
  type SearchReportJson,
  type SearchReportPlan,
  searchReport,
} from '../context/searchReport.ts';
import { SearchPatternError } from '../context/transcriptSearch.ts';
import { humanizeDuration } from '../util/duration.ts';
import { HOME } from '../util/env.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { type ParsedFlags, parseFlags, UsageError } from './flags.ts';
import { COMMANDS, usageLine } from './help.ts';

/** `ccmux search --report` — reads the command line and prints what `context/searchReport.ts` answers. */

/** What a report reads; every other flag of `search` is about a search and is refused here. */
const REPORT_FLAGS = new Set(['report', 'since', 'until', 'machine', 'local', 'limit', 'json']);
const DEFAULT_SINCE = '7d';
const DEFAULT_NEWEST = 20;

export interface ReportOpts extends SearchReportPlan {
  json: boolean;
  /** How many of the newest searches are listed. */
  newest: number;
}

function given(flags: ParsedFlags, name: string): boolean {
  const kind = COMMANDS.find((command) => command.verb === 'search')?.flags?.find(
    (flag) => flag.name === name,
  )?.kind;
  if (kind === 'boolean') return flags.bool(name);
  if (kind === 'list') return flags.list(name).length > 0;
  if (kind === 'int') return flags.int(name) !== undefined;
  return flags.str(name) !== undefined;
}

export function parseSearchReport(args: string[], now = Date.now()): ReportOpts {
  const usage = (message: string) => new UsageError(`${message}\n${usageLine('search')}`);
  const flags = parseFlags('search', args, [0, 1]);
  if (flags.positionals.length > 0)
    throw usage('--report reads the journal of searches; it takes no PATTERN');
  const names = COMMANDS.find((command) => command.verb === 'search')?.flags ?? [];
  const foreign = names.find((flag) => !REPORT_FLAGS.has(flag.name) && given(flags, flag.name));
  if (foreign !== undefined) throw usage(`--${foreign.name} is about a search; --report has none`);
  if (flags.bool('local') && flags.list('machine').length > 0)
    throw usage('choose --local or --machine');
  const until = flags.str('until');
  return {
    since: parseWhen(flags.str('since') ?? DEFAULT_SINCE, 'since', now),
    until: until === undefined ? null : parseWhen(until, 'until', now),
    machines: flags.bool('local')
      ? []
      : flags.list('machine').length > 0
        ? flags.list('machine')
        : null,
    json: flags.bool('json'),
    newest: flags.int('limit') ?? DEFAULT_NEWEST,
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** The nearest-rank quantile: the smallest value with at least `share` of the values at or below it. */
function quantile(sorted: number[], share: number): number {
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${Math.round((part * 100) / whole)}%`;

const homeRelative = (dir: string): string =>
  dir === HOME ? '~' : dir.startsWith(`${HOME}/`) ? `~${dir.slice(HOME.length)}` : dir;

/** Who asked, or where from when nothing named them. */
const askedBy = (entry: SearchJournalEntry): string =>
  entry.caller ?? (entry.dir === null ? '(not named)' : `(not named) ${homeRelative(entry.dir)}`);

const missed = (entry: SearchJournalEntry): boolean =>
  entry.machines.some((row) => row.status === 'unavailable');

/** The question as the caller put it: a pattern, or what an outline was of. */
function question(entry: SearchJournalEntry): string {
  const { query } = entry;
  const text =
    query.pattern ??
    [
      query.project === null ? null : `--project ${query.project}`,
      query.since === null ? null : `--since ${query.since}`,
    ]
      .filter((part) => part !== null)
      .join(' ');
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** The report a person reads: totals, time, who searches, the newest searches, and what was not read. */
export function reportLines(report: SearchReportJson, now: number, newest: number): string[] {
  const { entries } = report;
  const read = report.machines.filter((row) => row.status === 'read');
  const lines: string[] = [];
  const modes = ['lines', 'map', 'outline', 'receipts']
    .map((mode) => [mode, entries.filter((entry) => entry.mode === mode).length] as const)
    .filter(([, count]) => count > 0)
    .map(([mode, count]) => `${mode} ${count}`);
  lines.push(
    `${entries.length} search(es) since ${report.since}${report.until === null ? '' : ` until ${report.until}`} — journals of ${read.map((row) => row.machine).join(', ') || 'no machine'}${modes.length > 0 ? ` — ${modes.join(', ')}` : ''}`,
  );
  if (entries.length > 0) {
    const nothing = entries.filter((entry) => entry.total === 0).length;
    const partial = entries.filter(missed).length;
    lines.push(
      `found nothing: ${nothing} (${percent(nothing, entries.length)}); a machine not searched: ${partial} (${percent(partial, entries.length)})`,
    );
    const times = entries.map((entry) => entry.elapsedMs).sort((a, b) => a - b);
    lines.push(
      `time: median ${seconds(quantile(times, 0.5))}, p95 ${seconds(quantile(times, 0.95))}, longest ${seconds(times.at(-1) ?? 0)}`,
    );
    const callers = new Map<string, SearchJournalEntry[]>();
    for (const entry of entries)
      callers.set(askedBy(entry), [...(callers.get(askedBy(entry)) ?? []), entry]);
    const byCaller = [...callers.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([caller, asked]) => [
        caller,
        String(asked.length),
        String(asked.filter((entry) => entry.total === 0).length),
        humanizeDuration((now - Date.parse(asked.at(-1)?.at ?? report.since)) / 1000),
      ]);
    lines.push('', ...tableLines(['CALLER', 'SEARCHES', 'NOTHING', 'LAST'], byCaller));
    const recent = entries
      .slice(-newest)
      .map((entry) => [
        humanizeDuration((now - Date.parse(entry.at)) / 1000),
        entry.machine,
        askedBy(entry),
        entry.mode,
        question(entry),
        `${entry.total}${missed(entry) ? '+?' : ''}`,
        seconds(entry.elapsedMs),
      ]);
    lines.push(
      '',
      `newest ${recent.length}:`,
      ...tableLines(['AGE', 'MACHINE', 'CALLER', 'MODE', 'QUESTION', 'FOUND', 'TIME'], recent),
    );
  }
  const unreadable = read.filter((row) => row.unreadable > 0);
  if (unreadable.length > 0)
    lines.push(
      `journal lines that could not be read: ${unreadable.map((row) => `${row.unreadable} on ${row.machine}`).join(', ')}`,
    );
  // Said as loudly as the totals: a machine whose journal was not read may hold the searches.
  for (const row of report.machines)
    if (row.status === 'unavailable') lines.push(`NOT READ: ${row.machine} — ${row.error}`);
  return lines;
}

export async function cmdSearchReport(args: string[]): Promise<number> {
  let opts: ReportOpts;
  try {
    opts = parseSearchReport(args);
  } catch (error) {
    if (!(error instanceof SearchPatternError)) throw error;
    console.error(error.message);
    return 2;
  }
  const report = await searchReport(loadMachineConfig(), opts);
  const lines = opts.json ? [JSON.stringify(report)] : reportLines(report, Date.now(), opts.newest);
  for (const line of lines) await printLine(line);
  return report.machines.some((row) => row.status === 'unavailable') ? 2 : 0;
}
