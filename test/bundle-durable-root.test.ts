import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateBundleToDurableRoot } from "../src/config/migrateBundle.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ccmux-roots-"));
}

/** The roots are read from the environment when paths.ts is first imported, so the layout question
 *  is answered in a child process with that environment set — the same way a real install sees it. */
function rootsUnder(root: string): { app: string; data: string; cache: string; staged: string; releases: string } {
  const script =
    'const p = await import("' +
    join(process.cwd(), "src/config/paths.ts") +
    '"); console.log(JSON.stringify({app: p.APP_BUNDLE, data: p.DATA_DIR, cache: p.CACHE_DIR, staged: p.STAGED_BUNDLE, releases: p.RELEASES_DIR}));';
  const r = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, CCMUX_DATA_DIR: join(root, "share", "ccmux"), CCMUX_CACHE_DIR: join(root, "cache", "ccmux") },
  });
  return JSON.parse(r.stdout.toString());
}

test("the bundle no longer lives under the cache root", () => {
  const root = tmpRoot();
  const p = rootsUnder(root);
  expect(p.app.startsWith(p.cache)).toBe(false);
  expect(p.app.startsWith(p.data)).toBe(true);
  // What a download or a build can rebuild stays disposable.
  expect(p.staged.startsWith(p.cache)).toBe(true);
  expect(p.releases.startsWith(p.cache)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("wiping the cache root leaves the runnable code untouched", () => {
  const root = tmpRoot();
  const p = rootsUnder(root);
  mkdirSync(join(p.data, "app"), { recursive: true });
  writeFileSync(p.app, "// the tool");
  mkdirSync(p.cache, { recursive: true });
  writeFileSync(join(p.cache, "junk"), "x");

  rmSync(p.cache, { recursive: true, force: true }); // the exact command that caused the incident

  expect(existsSync(p.app)).toBe(true);
  expect(readFileSync(p.app, "utf8")).toBe("// the tool");
  rmSync(root, { recursive: true, force: true });
});

test("a legacy install is carried over, rollback copy included", () => {
  const root = tmpRoot();
  const app = join(root, "share", "ccmux", "app", "ccmux.js");
  const legacy = join(root, "cache", "ccmux", "app", "ccmux.js");
  mkdirSync(join(root, "cache", "ccmux", "app"), { recursive: true });
  writeFileSync(legacy, "// old location");
  writeFileSync(`${legacy}.bak`, "// previous version");

  expect(migrateBundleToDurableRoot(app, legacy)).toBe("moved");
  expect(readFileSync(app, "utf8")).toBe("// old location");
  // The boot guard's only escape from a crash loop must not be left behind in the directory
  // the move exists to abandon.
  expect(readFileSync(`${app}.bak`, "utf8")).toBe("// previous version");
  // The old copy stays until the machine is fully converged: a boot manager may still be serving the
  // definition that names it, and a path it believes in must not vanish under it.
  expect(existsSync(legacy)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("migration reports an empty machine honestly and never overwrites a live bundle", () => {
  const root = tmpRoot();
  const app = join(root, "share", "ccmux", "app", "ccmux.js");
  const legacy = join(root, "cache", "ccmux", "app", "ccmux.js");

  expect(migrateBundleToDurableRoot(app, legacy)).toBe("absent"); // nothing anywhere

  mkdirSync(join(root, "share", "ccmux", "app"), { recursive: true });
  writeFileSync(app, "// current");
  mkdirSync(join(root, "cache", "ccmux", "app"), { recursive: true });
  writeFileSync(legacy, "// stale copy");

  expect(migrateBundleToDurableRoot(app, legacy)).toBe("already");
  expect(readFileSync(app, "utf8")).toBe("// current");
  rmSync(root, { recursive: true, force: true });
});
