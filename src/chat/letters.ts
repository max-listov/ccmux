import type { LogRow } from './feedSchema.ts';

/**
 * How many letters a session has exchanged, and when the last one was.
 *
 * A consumer showing a session card wants to tell a twenty-turn correspondence from one opened a
 * minute ago, and the only complete record of that is this machine's. What a consumer could reach
 * was a WINDOW of it — `chat log -n 30`, or up to two hundred lines of the live feed — and a count
 * taken over a window is the size of the window: measured on one machine over two minutes it read
 * 65, then 70, then 13, then 7, moving with each snapshot rather than with the conversation.
 *
 * Counted from the same rows `chat log` prints, deliberately: ledger for what arrived and outbox for
 * what this machine sent, one definition rather than two that agree until they do not.
 */
export interface SessionLetters {
  total: number;
  /** ISO-8601 of the most recent letter, or null when there has never been one. */
  lastAt: string | null;
}

/**
 * The session name a party is, when it is one of this machine's sessions.
 *
 * Null covers three different parties and one non-party: the owner, the command line, a session on
 * another machine — and a record this build cannot read, which becomes a row with no sender and no
 * target at all. None of them is a session of ours, so none of them counts, and a row with an empty
 * timestamp cannot reach the running maximum through them.
 */
const sessionOf = (party: LogRow['sender'] | LogRow['target'], machine: string): string | null =>
  party !== null && party.kind === 'managed' && party.machine === machine ? party.session : null;

/**
 * Letters per session name, for the sessions of one machine.
 *
 * A letter is counted once for the session that sent it and once for the session that received it,
 * which is what "how many has this session exchanged" means — and when a session writes to itself
 * (a router's own watchdog does exactly that) it is still one letter, not two.
 */
export function letterCounts(
  rows: readonly LogRow[],
  machine: string,
): Map<string, SessionLetters> {
  const counts = new Map<string, SessionLetters>();
  const bump = (name: string | null, ts: string) => {
    if (name === null) return;
    const current = counts.get(name) ?? { total: 0, lastAt: null };
    counts.set(name, {
      total: current.total + 1,
      lastAt: current.lastAt === null || ts > current.lastAt ? ts : current.lastAt,
    });
  };
  for (const row of rows) {
    const from = sessionOf(row.sender, machine);
    const to = sessionOf(row.target, machine);
    bump(from, row.ts);
    if (to !== from) bump(to, row.ts);
  }
  return counts;
}

/** What a session with no letters reports. Not the absence of the field: "none" and "this build
 *  does not say" are different answers, and only one of them is about the conversation. */
export const NO_LETTERS: SessionLetters = { total: 0, lastAt: null };
