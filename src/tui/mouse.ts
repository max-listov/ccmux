/** One SGR (mode 1006) mouse report: which button, where, and whether it is the release. */
export interface MouseReport {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;
/** Set on every report sent while the pointer moves (any-motion tracking, mode 1003). */
export const MOTION = 32;

/** Every mouse report in a raw input chunk, in order. */
export function sgrReports(raw: string): MouseReport[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports start with a literal ESC byte.
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const reports: MouseReport[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw))
    reports.push({ button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), release: m[4] === 'm' });
  return reports;
}
