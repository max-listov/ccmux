import type { PlanLimits, PlanWindow } from '../runtime/planLimits.ts';

/**
 * What `claude -p "/usage"` prints, read into plan windows.
 *
 * The command is the vendor's own answer to "how full is this account", needs no token from us and
 * works for an account nobody is using right now. It prints text, so the reader is strict: a line it
 * does not recognise is an error with the line quoted, never a guess and never an empty measurement.
 *
 *   You are currently using your subscription to power your Claude Code usage
 *   Current session: 17% used · resets Oct 17 at 11:59pm (Asia/Bangkok)
 *   Current week (all models): 51% used · resets Oct 20 at 6:59pm (Asia/Bangkok)
 *   Current week (Fable): 0% used · resets Oct 20 at 7pm (Asia/Bangkok)
 *
 * A window at zero prints no reset (nothing is counting down). The reset has no year and is named in
 * a time zone the line itself carries, so both are taken from the line and the clock — never from
 * the machine's own zone, which is not the account's.
 */

export type UsageParse =
  | { kind: 'windows'; windows: PlanWindow[] }
  | { kind: 'unrecognised'; line: string };

const WINDOW_LINE =
  /^Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/i;
const ZONE_SUFFIX = /^(.*?)\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)+|UTC|GMT)\)\s*$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The offset of `zone` from UTC at `instant`, in ms, as the zone itself reports it. */
function zoneOffsetMs(instant: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(instant));
    const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      at('year'),
      at('month') - 1,
      at('day'),
      at('hour'),
      at('minute'),
      at('second'),
    );
    return Number.isNaN(asUtc) ? null : asUtc - Math.floor(instant / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The instant at which the wall clock of `zone` reads the given date and time. */
export function zonedInstant(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  zone: string,
): number | null {
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const first = zoneOffsetMs(wall, zone);
  if (first === null) return null;
  // The offset at the guess can differ from the offset at the answer across a daylight change; one
  // correction settles it for every zone that has one.
  const guess = wall - first;
  const second = zoneOffsetMs(guess, zone);
  return second === null ? null : wall - second;
}

/**
 * A reset written as month, day and clock time (or the clock time alone, meaning today), in `zone`,
 * as an instant. The line names no year: it is the one that puts the date nearest to now.
 */
export function parseReset(text: string, zone: string, now: number): number | null {
  const match =
    /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(
      text.trim(),
    );
  if (match === null) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText) % 12;
  if ((meridiem ?? '').toLowerCase() === 'pm') hour += 12;
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const today = zoneOffsetMs(now, zone);
  if (today === null) return null;
  const local = new Date(now + today);
  let month = local.getUTCMonth() + 1;
  let day = local.getUTCDate();
  let year = local.getUTCFullYear();
  if (monthName !== undefined && dayText !== undefined) {
    const index = MONTHS.indexOf(monthName.toLowerCase());
    if (index < 0) return null;
    month = index + 1;
    day = Number(dayText);
    if (yearText !== undefined) year = Number(yearText);
    else {
      // The line names no year. A reset is days away, so the year is the one that puts the date
      // nearest to now — which also holds across New Year in either direction.
      let best: number | null = null;
      for (const candidate of [year - 1, year, year + 1]) {
        const at = zonedInstant({ year: candidate, month, day, hour, minute }, zone);
        if (at !== null && (best === null || Math.abs(at - now) < Math.abs(best - now))) best = at;
      }
      return best;
    }
  }
  return zonedInstant({ year, month, day, hour, minute }, zone);
}

function windowKey(kind: string, scope: string | undefined): { key: string; scope: string | null } {
  if (kind.toLowerCase() === 'session') return { key: 'five_hour', scope: null };
  const named = scope?.trim();
  if (named === undefined || named === '' || /^all models$/i.test(named))
    return { key: 'seven_day', scope: null };
  return { key: `model_scoped:${named}`, scope: named };
}

export function parseClaudeUsage(text: string, now: number): UsageParse {
  const windows: PlanWindow[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^Current /i.test(line)) continue;
    const match = WINDOW_LINE.exec(line);
    if (match === null) return { kind: 'unrecognised', line: line.slice(0, 160) };
    const [, kind, scopeText, percentText, resetText] = match;
    const { key, scope } = windowKey(kind ?? '', scopeText);
    let resetsAt: string | null = null;
    if (resetText !== undefined) {
      const zoned = ZONE_SUFFIX.exec(resetText);
      const instant = zoned?.[1] && zoned[2] ? parseReset(zoned[1], zoned[2], now) : null;
      // A reset that cannot be read stays unknown; the percentage on the same line is still true.
      resetsAt = instant === null ? null : new Date(instant).toISOString();
    }
    windows.push({
      key,
      label: scope,
      percent: Math.min(100, Math.round(Number(percentText) * 10) / 10),
      windowMinutes: null,
      resetsAt,
      scope,
    });
  }
  if (windows.length > 0) return { kind: 'windows', windows };
  // Not a report this reader knows. Whether the account is billed by the token is decided from who
  // is signed in (`claude auth status`), never from how this text happens to be worded.
  return { kind: 'unrecognised', line: text.trim().split('\n')[0]?.slice(0, 160) ?? '' };
}

/** The windows as the shared vocabulary carries them. */
export function usageLimits(
  parsed: Extract<UsageParse, { kind: 'windows' }> | { kind: 'no-plan-limit' },
  plan: string | null,
  now: number,
): PlanLimits {
  return {
    answer: parsed.kind === 'windows' ? 'known' : 'no-plan-limit',
    plan,
    windows: parsed.kind === 'windows' ? parsed.windows : [],
    observedAt: new Date(now).toISOString(),
    source: 'probe',
    error: null,
  };
}
