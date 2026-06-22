import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootGuardStart, clearBootGuard, MAX_ATTEMPTS } from "../src/util/bootGuard.ts";

function sandbox(): { counter: string; app: string; bak: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-guard-"));
  const app = join(dir, "ccmux.js");
  writeFileSync(app, "BAD-CURRENT"); // pretend the live bundle is the crash-looping one
  writeFileSync(`${app}.bak`, "GOOD-PREVIOUS");
  return { counter: join(dir, "boot-attempts"), app, bak: `${app}.bak` };
}

test("first starts are ok and increment the counter", () => {
  const { counter, app } = sandbox();
  expect(bootGuardStart(counter, app)).toBe("ok");
  expect(readFileSync(counter, "utf8").trim()).toBe("1");
  expect(bootGuardStart(counter, app)).toBe("ok");
  expect(readFileSync(counter, "utf8").trim()).toBe("2");
});

test("reaching MAX_ATTEMPTS reverts bundle from .bak and signals revert", () => {
  const { counter, app } = sandbox();
  for (let i = 1; i < MAX_ATTEMPTS; i++) expect(bootGuardStart(counter, app)).toBe("ok");
  expect(bootGuardStart(counter, app)).toBe("revert");
  expect(readFileSync(app, "utf8")).toBe("GOOD-PREVIOUS"); // restored from .bak
  expect(existsSync(counter)).toBe(false); // counter cleared so it doesn't loop forever
});

test("a successful pass clears the counter — the crash budget resets", () => {
  const { counter, app } = sandbox();
  bootGuardStart(counter, app);
  bootGuardStart(counter, app);
  clearBootGuard(counter);
  expect(existsSync(counter)).toBe(false);
  expect(bootGuardStart(counter, app)).toBe("ok"); // back to attempt 1, not tripping
  expect(readFileSync(counter, "utf8").trim()).toBe("1");
});

test("no .bak → does NOT revert (can't make things worse), clears to avoid a dead loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-guard-nobak-"));
  const app = join(dir, "ccmux.js");
  writeFileSync(app, "CURRENT");
  const counter = join(dir, "boot-attempts");
  let r: "ok" | "revert" = "ok";
  for (let i = 0; i < MAX_ATTEMPTS; i++) r = bootGuardStart(counter, app);
  expect(r).toBe("ok"); // no backup to restore → stay on current
  expect(readFileSync(app, "utf8")).toBe("CURRENT");
  expect(existsSync(counter)).toBe(false);
});
