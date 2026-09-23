import { appendFileSync } from 'node:fs';
import { MOTION, sgrReports, WHEEL_DOWN, WHEEL_UP } from './mouse.ts';

// Capped mouse logger (CCMUX_MOUSE_DEBUG=1). Logs to /tmp/ccmux-mouse.log with a HARD
// line cap so any-motion tracking can NEVER fill the disk again.

export const MOUSE_LOG = '/tmp/ccmux-mouse.log';
export const mouseDebugOn = process.env.CCMUX_MOUSE_DEBUG === '1';

let written = 0;
const MAX_LINES = 300;

export function logMouse(tag: string, detail: string): void {
  if (!mouseDebugOn || written >= MAX_LINES) return;
  written += 1;
  try {
    appendFileSync(MOUSE_LOG, `${new Date().toISOString()} ${tag} ${detail}\n`);
  } catch {
    // best-effort
  }
}

/** Human-readable summary of any SGR mouse events found in a raw chunk. */
export function describeSgr(raw: string): string {
  const out = sgrReports(raw).map(({ button: b, x, y, release }) => {
    const kind =
      b === WHEEL_UP
        ? 'wheelUp'
        : b === WHEEL_DOWN
          ? 'wheelDown'
          : (b & MOTION) !== 0
            ? 'motion'
            : release
              ? 'release'
              : 'press';
    return `${kind}(b=${b},x=${x},y=${y})`;
  });
  return out.length > 0 ? out.join(' ') : '—';
}
