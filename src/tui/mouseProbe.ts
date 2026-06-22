import { appendFileSync } from "node:fs";

// Capped mouse logger (CCMUX_MOUSE_DEBUG=1). Logs to /tmp/ccmux-mouse.log with a HARD
// line cap so any-motion tracking can NEVER fill the disk again.

export const MOUSE_LOG = "/tmp/ccmux-mouse.log";
export const mouseDebugOn = process.env.CCMUX_MOUSE_DEBUG === "1";

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
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const out: string[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const b = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const release = m[4] === "m";
    let kind: string;
    if (b === 64) kind = "wheelUp";
    else if (b === 65) kind = "wheelDown";
    else if ((b & 32) !== 0) kind = "motion";
    else kind = release ? "release" : "press";
    out.push(`${kind}(b=${b},x=${x},y=${y})`);
  }
  return out.length > 0 ? out.join(" ") : "—";
}
