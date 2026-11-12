import { z } from 'zod';
import { askPeer, FROM_ANOTHER_MACHINE, NOT_IN_FLEET, type PeerRunner } from '../fleet/askPeer.ts';
import { peersOf } from '../fleet/transport.ts';
import type { MachineConfig } from '../types.ts';
import { readSearchJournal, SearchJournalEntrySchema } from './searchJournal.ts';

/**
 * Who searched, for what, and how it went — every machine's search journal for one period.
 *
 * Each machine reads its own journal: this one here, every other one asked to do the same with
 * `--local`. A machine that did not answer is named; its silence is not "nobody searched there".
 */

const PEER_TIMEOUT_MS = 20_000;
const PEER_CONNECT_SECONDS = 5;

export const SearchReportEntrySchema = SearchJournalEntrySchema.extend({
  /** The machine whose journal holds the line: where the search was asked. */
  machine: z.string().min(1),
});
export type SearchReportEntry = z.infer<typeof SearchReportEntrySchema>;

export const SearchReportJsonSchema = z.strictObject({
  since: z.iso.datetime(),
  until: z.iso.datetime().nullable(),
  machines: z.array(
    z.discriminatedUnion('status', [
      z.strictObject({
        machine: z.string().min(1),
        status: z.literal('read'),
        searches: z.int().nonnegative(),
        /** Lines of its journal that are not journal lines; counted, never silently left out. */
        unreadable: z.int().nonnegative(),
      }),
      z.strictObject({
        machine: z.string().min(1),
        status: z.literal('unavailable'),
        error: z.string(),
      }),
    ]),
  ),
  /** Oldest first. */
  entries: z.array(SearchReportEntrySchema),
});
export type SearchReportJson = z.infer<typeof SearchReportJsonSchema>;

export interface SearchReportPlan {
  since: number;
  until: number | null;
  /** Machines to read, `[]` for this one alone, or null for every machine of the fleet. */
  machines: string[] | null;
}

type MachineReport = Pick<SearchReportJson, 'machines' | 'entries'>;

const unavailable = (machine: string, error: string): MachineReport => ({
  machines: [{ machine, status: 'unavailable', error }],
  entries: [],
});

function reportHere(m: MachineConfig, plan: SearchReportPlan): MachineReport {
  const { entries, unreadable } = readSearchJournal(m, plan.since, plan.until);
  return {
    machines: [{ machine: m.rcPrefix, status: 'read', searches: entries.length, unreadable }],
    entries: entries.map((entry) => ({ ...entry, machine: m.rcPrefix })),
  };
}

async function reportThere(
  m: MachineConfig,
  peer: { machine: string; alias: string | null },
  plan: SearchReportPlan,
  runPeer: PeerRunner | undefined,
): Promise<MachineReport> {
  const asked = await askPeer(
    m,
    peer,
    [
      'ccmux',
      'search',
      '--report',
      '--local',
      '--json',
      '--since',
      new Date(plan.since).toISOString(),
      ...(plan.until === null ? [] : ['--until', new Date(plan.until).toISOString()]),
    ],
    (stdout) => SearchReportJsonSchema.parse(JSON.parse(stdout)),
    {
      what: 'search report',
      timeoutMs: PEER_TIMEOUT_MS,
      connectTimeoutSeconds: PEER_CONNECT_SECONDS,
      runPeer,
    },
  );
  if (!asked.ok) return unavailable(peer.machine, asked.error);
  const own = asked.answer.machines.filter((row) => row.machine === peer.machine);
  if (own.length !== 1 || asked.answer.entries.some((entry) => entry.machine !== peer.machine))
    return unavailable(peer.machine, FROM_ANOTHER_MACHINE);
  return { machines: own, entries: asked.answer.entries };
}

export async function searchReport(
  m: MachineConfig,
  plan: SearchReportPlan,
  runPeer?: PeerRunner,
): Promise<SearchReportJson> {
  const peers = peersOf(m);
  const targets =
    plan.machines === null
      ? [m.rcPrefix, ...peers.map((peer) => peer.machine)]
      : plan.machines.length === 0
        ? [m.rcPrefix]
        : plan.machines;
  const answers = await Promise.all(
    [...new Set(targets)].map((machine): Promise<MachineReport> => {
      if (machine === m.rcPrefix) return Promise.resolve(reportHere(m, plan));
      const peer = peers.find((candidate) => candidate.machine === machine);
      return peer === undefined
        ? Promise.resolve(unavailable(machine, NOT_IN_FLEET))
        : reportThere(m, peer, plan, runPeer);
    }),
  );
  return {
    since: new Date(plan.since).toISOString(),
    until: plan.until === null ? null : new Date(plan.until).toISOString(),
    machines: answers.flatMap((answer) => answer.machines),
    entries: answers
      .flatMap((answer) => answer.entries)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  };
}
