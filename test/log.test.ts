import { expect, test, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh process resolves the real logger's state path before any module can cache it.
// Changing an environment variable around a cached dynamic import cannot isolate filesystem IO.
const sandbox = mkdtempSync(join(tmpdir(), "ccmux-log-"));
const LOG_FILE = join(sandbox, "ccmux.log");
let threshold = "info";
const setLogLevel = (level: string) => { threshold = level; };
function emit(level: string, fields: Record<string, unknown>): void {
  const child = Bun.spawnSync([process.execPath, "-e", [
    "const { log, setLogLevel, LOG_FILE } = await import(process.env.CCMUX_TEST_LOGGER);",
    "setLogLevel(process.env.CCMUX_TEST_LEVEL);",
    "log[process.env.CCMUX_TEST_METHOD](JSON.parse(process.env.CCMUX_TEST_FIELDS));",
    "console.log(LOG_FILE);",
  ].join("\n")], {
    env: { ...process.env, CCMUX_STATE_DIR: sandbox,
      CCMUX_TEST_LOGGER: new URL("../src/util/log.ts", import.meta.url).href,
      CCMUX_TEST_LEVEL: threshold, CCMUX_TEST_METHOD: level, CCMUX_TEST_FIELDS: JSON.stringify(fields) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe(LOG_FILE);
}
const log = {
  debug: (fields: Record<string, unknown>) => emit("debug", fields),
  info: (fields: Record<string, unknown>) => emit("info", fields),
  warn: (fields: Record<string, unknown>) => emit("warn", fields),
  error: (fields: Record<string, unknown>) => emit("error", fields),
};
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

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
