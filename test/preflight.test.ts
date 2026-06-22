import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightBundle } from "../src/commands/update.ts";

// preflightBundle runs `bun <path> version` and checks the printed version. We build tiny
// fake "bundles" (plain bun scripts) to exercise the three outcomes without a real build.

function fakeBundle(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "ccmux-pf-")), "ccmux.js");
  writeFileSync(p, body);
  return p;
}

test("matching version → null (passes, live bundle would be swapped)", async () => {
  const p = fakeBundle(`if (Bun.argv[2] === "version") console.log("ccmux 1.2.3");`);
  expect(await preflightBundle(p, "1.2.3")).toBeNull();
});

test("wrong version → error (ABORT, live bundle untouched)", async () => {
  const p = fakeBundle(`if (Bun.argv[2] === "version") console.log("ccmux 9.9.9");`);
  const r = await preflightBundle(p, "1.2.3");
  expect(r).toContain("preflight failed");
  expect(r).toContain("9.9.9");
});

test("bundle that won't even load → error (the deadly class we guard against)", async () => {
  const p = fakeBundle(`this is not valid javascript ){{`);
  const r = await preflightBundle(p, "1.2.3");
  expect(r).toContain("preflight failed"); // bundleVersion returns "?" on crash → mismatch
});
