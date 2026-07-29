import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../scripts/bundle.ts";

// The prod bundle must be TRULY self-contained: it starts with no bun cache and no network. This is
// the exact failure that shipped for months invisibly — ink's hoisted `import "react-devtools-core"`
// resolved at load against the global cache, so a cache-cleared / offline machine died on start with
// ENOENT. The guard builds via the SAME `buildBundle` the release uses, then runs the bundle under
// full isolation. It catches react-devtools-core AND any future hoisted external ink (or a dep) adds.

test("the shipped bundle carries no react-devtools-core import (the specific regression)", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "ccmux-bundle-")), "ccmux.js");
  expect(await buildBundle(out)).toBe(true);
  expect(readFileSync(out, "utf8")).not.toContain('from "react-devtools-core"');
}, 60_000);

test("the shipped bundle starts with an EMPTY bun cache and NO network (the real invariant)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-bundle-iso-"));
  const out = join(dir, "ccmux.js");
  expect(await buildBundle(out)).toBe(true);

  // Isolate resolution: a fresh empty HOME (⇒ empty ~/.bun cache), an empty cache dir, and a dead
  // registry — so a leftover hoisted external import cannot be satisfied by cache OR auto-install.
  // A regressed bundle dies here with `Cannot find package '…'`; a self-contained one just runs.
  const fakeHome = join(dir, "home");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = fakeHome;
  env.BUN_INSTALL_CACHE_DIR = join(fakeHome, ".bun", "install", "cache");
  env.BUN_CONFIG_REGISTRY = "http://127.0.0.1:1"; // nothing listens → no network install

  const proc = Bun.spawn(["bun", out, "version"], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).not.toContain("Cannot find package");
  expect(code).toBe(0);
  expect(stdout).toContain("ccmux");
}, 60_000);
