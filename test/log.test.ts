import { expect, test, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// log.ts resolves LOG_FILE from CCMUX_HOME at import time (HOME-derived). Rather than fight
// that, test the two pure-ish behaviors directly against a sandbox: level threshold and the
// size-based rotation shift. We re-implement nothing — we import the real symbols and point
// HOME at a temp dir BEFORE importing.

const sandbox = mkdtempSync(join(tmpdir(), "ccmux-log-"));
const realHome = process.env.HOME;
process.env.HOME = sandbox;

// dynamic import AFTER HOME is set, so CCMUX_HOME/LOG_FILE land in the sandbox…
const { log, setLogLevel, LOG_FILE } = await import("../src/util/log.ts");
// …then restore HOME so this file doesn't pollute HOME-dependent tests (resume tripwire etc.)
if (realHome !== undefined) process.env.HOME = realHome;

function reset(): void {
  rmSync(LOG_FILE, { force: true });
  for (const i of [1, 2, 3]) rmSync(`${LOG_FILE}.${i}`, { force: true });
  setLogLevel("info");
}

beforeEach(reset);

test("threshold drops below-level events, keeps at/above", () => {
  setLogLevel("warn");
  log.debug({ msg: "d" });
  log.info({ msg: "i" });
  log.warn({ msg: "w" });
  log.error({ msg: "e" });
  const body = readFileSync(LOG_FILE, "utf8");
  expect(body).not.toContain('"msg":"d"');
  expect(body).not.toContain('"msg":"i"');
  expect(body).toContain('"msg":"w"');
  expect(body).toContain('"msg":"e"');
});

test("debug level lets everything through", () => {
  setLogLevel("debug");
  log.debug({ msg: "dbg" });
  expect(readFileSync(LOG_FILE, "utf8")).toContain('"msg":"dbg"');
});

test("one JSON object per line with ts/pid/level/msg", () => {
  log.info({ msg: "hello", extra: 7 });
  const line = readFileSync(LOG_FILE, "utf8").trim().split("\n").at(-1) ?? "";
  const obj = JSON.parse(line);
  expect(obj.msg).toBe("hello");
  expect(obj.extra).toBe(7);
  expect(obj.level).toBe("info");
  expect(typeof obj.ts).toBe("string");
  expect(typeof obj.pid).toBe("number");
});

test("rotation shifts LOG_FILE → .1 when it exceeds the size cap", () => {
  // Pre-fill the live file past the 5MB cap, then one write triggers the rotate.
  writeFileSync(LOG_FILE, "x".repeat(6 * 1024 * 1024));
  log.info({ msg: "after-rotate" });
  expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  expect(statSync(`${LOG_FILE}.1`).size).toBeGreaterThan(5 * 1024 * 1024); // old big file moved aside
  const live = readFileSync(LOG_FILE, "utf8");
  expect(live).toContain('"msg":"after-rotate"'); // new small live file
  expect(live.length).toBeLessThan(1024);
});

test("rotation caps generations at .2 (no unbounded growth)", () => {
  for (let gen = 0; gen < 4; gen++) {
    writeFileSync(LOG_FILE, "x".repeat(6 * 1024 * 1024));
    log.info({ msg: `gen${gen}` });
  }
  expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  expect(existsSync(`${LOG_FILE}.2`)).toBe(true);
  expect(existsSync(`${LOG_FILE}.3`)).toBe(false); // KEEP=2 — never a third rotated file
});
