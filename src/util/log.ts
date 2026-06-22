// Structured JSON logs — ONE line per event. Always appended to a persistent file
// (`~/.ccmux/ccmux.log`) so the TUI/dev — whose stderr is swallowed by the terminal — still
// leaves a trail we can `tail`. Also mirrored to stderr (daemon launchd/journal .err), but
// the TUI disables that mirror so log writes never corrupt the Ink render.
//
// Levels: debug < info < warn < error. Threshold defaults to "info"; long-lived processes
// (daemon, _run) raise/lower it from machine.json `logLevel` — live, no restart needed.
// Rotation: size-based at write time, ccmux.log → .1 → .2 (≈5MB × 3 ≈ 15MB cap) — fixed
// sane bounds, intentionally NOT config (a runaway log should never eat a server disk).

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { CCMUX_HOME } from "../config/paths.ts";
import { IS_DEV } from "../env.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = { msg: string } & Record<string, unknown>;

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 2; // rotated generations: .1, .2

export const LOG_FILE = `${CCMUX_HOME}/ccmux.log`;
let stderrOn = true; // daemon/CLI mirror to stderr; the TUI turns this off
let threshold: LogLevel = "info";
let dirReady = false;

/** TUI calls this before rendering Ink: file-only, no stderr (which would corrupt the UI). */
export function setStderrLogging(on: boolean): void {
  stderrOn = on;
}

/** Long-lived processes wire this to machine.json `logLevel` (re-read live each tick). */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Shift ccmux.log → .1 → .2 when the live file exceeds MAX_BYTES. Failures are swallowed —
 *  rotation is best-effort and must never block a log write. */
function rotateIfNeeded(): void {
  try {
    if (statSync(LOG_FILE).size < MAX_BYTES) return;
  } catch {
    return; // no file yet — nothing to rotate
  }
  try {
    rmSync(`${LOG_FILE}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`);
      } catch {
        // generation missing — fine
      }
    }
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // rotation must never crash the app
  }
}

function writeFile(line: string): void {
  try {
    if (!dirReady) {
      mkdirSync(CCMUX_HOME, { recursive: true });
      dirReady = true;
    }
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line);
  } catch {
    // logging must NEVER crash the app
  }
}

function emit(level: LogLevel, fields: Fields): void {
  if (SEVERITY[level] < SEVERITY[threshold]) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, src: IS_DEV ? "dev" : "prod", level, ...fields })}\n`;
  writeFile(line);
  if (stderrOn) process.stderr.write(line);
}

export const log = {
  debug: (fields: Fields) => emit("debug", fields),
  info: (fields: Fields) => emit("info", fields),
  warn: (fields: Fields) => emit("warn", fields),
  error: (fields: Fields) => emit("error", fields),
};
