#!/usr/bin/env bun
// DEV release tooling — runs ONLY from the source checkout (package.json scripts). This is
// NOT part of the `ccmux` tool that ships to the fleet: clients have a bundle, no repo, no
// package.json, so they can never build or publish a release.
//
//   bun run release X.Y.Z "notes"  → git CEREMONY (the only human release entrypoint):
//                                    clean-tree guard → bun run check → bump package.json
//                                    → CHANGELOG section → commit "X.Y.Z: notes" → tag
//                                    vX.Y.Z → push. Publishing happens in CI off the tag —
//                                    there is NO local publish path (tag ↔ code ↔ assets
//                                    stay one atomic story; see .github/workflows/ci.yml).
//   bun run stage                  → build bundle → ~/.ccmux/staged (local `ccmux update` test)
//   bun scripts/release.ts --local          → bundle + file:// manifest (sandbox e2e)
//   bun scripts/release.ts --ci-assets URL  → bundle + manifest at URL (CI release job only)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASES_DIR, RELEASE_BUNDLE, RELEASE_MANIFEST, STAGED_BUNDLE } from "../src/config/paths.ts";
import { VERSION, compareSemver } from "../src/util/version.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_CLI = join(ROOT, "src", "cli.ts");
const PKG_JSON = join(ROOT, "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

async function bundle(outfile: string): Promise<boolean> {
  mkdirSync(dirname(outfile), { recursive: true });
  // `--external react-devtools-core`: Ink imports it ONLY in devtools mode (gated on
  // `process.env.DEV === 'true'` in ink/reconciler.js) and it's an OPTIONAL peer dep that isn't
  // installed. Without external, the bundler can't resolve the import and the build fails. The
  // left-in runtime import is never reached in prod, so the deployed bundle (~/.ccmux/app, outside
  // any node_modules) runs fine. NOTE: only run the bundle from OUTSIDE the project tree — running
  // it from inside (e.g. dist/) makes Bun eagerly resolve the external against the project's
  // node_modules, which lacks the package, and errors. This is the canonical Ink-bundling pattern.
  const proc = Bun.spawn(
    ["bun", "build", "--target=bun", "--external", "react-devtools-core", SRC_CLI, "--outfile", outfile],
    { stdout: "inherit", stderr: "inherit" },
  );
  return (await proc.exited) === 0;
}

function sha256(path: string): { bytes: number; hex: string } {
  const buf = readFileSync(path);
  return { bytes: buf.length, hex: new Bun.CryptoHasher("sha256").update(buf).digest("hex") };
}

async function writeManifest(url: string, notes: string): Promise<string> {
  const { hex } = sha256(RELEASE_BUNDLE);
  const manifest = { version: VERSION, notes, sha256: hex, url };
  await Bun.write(RELEASE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return hex;
}

async function git(argv: string[], capture = false): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["git", "-C", ROOT, ...argv], {
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const out = capture ? (await new Response(proc.stdout).text()).trim() : "";
  return { ok: (await proc.exited) === 0, out };
}

async function doStage(): Promise<number> {
  if (!(await bundle(STAGED_BUNDLE))) return fail("build failed");
  console.log(`staged v${VERSION} → ${STAGED_BUNDLE}`);
  console.log("apply locally: ccmux update");
  return 0;
}

/** file:// release for the sandbox e2e (isolated HOME) — never for the real fleet. */
async function doLocal(notes: string): Promise<number> {
  mkdirSync(RELEASES_DIR, { recursive: true });
  if (!(await bundle(RELEASE_BUNDLE))) return fail("build failed");
  const { bytes, hex } = sha256(RELEASE_BUNDLE);
  await writeManifest(`file://${RELEASE_BUNDLE}`, notes);
  console.log(`built v${VERSION} → ${RELEASE_MANIFEST} (${(bytes / 1e6).toFixed(2)} MB, sha256 ${hex.slice(0, 12)}…)`);
  console.log(`  point machine.json releaseUrl at: file://${RELEASE_MANIFEST}`);
  return 0;
}

/** CI-only: build the two fleet assets with the manifest pointing at the VERSIONED
 *  GitHub asset url (atomic manifest+bundle pair). Publishing itself is the workflow's job. */
async function doCiAssets(url: string): Promise<number> {
  if (!url.startsWith("https://")) return fail("--ci-assets needs the versioned https bundle url");
  mkdirSync(RELEASES_DIR, { recursive: true });
  if (!(await bundle(RELEASE_BUNDLE))) return fail("build failed");
  const notes = changelogSection(VERSION) ?? `ccmux v${VERSION}`;
  const hex = await writeManifest(url, notes.split("\n")[0] ?? "");
  console.log(`assets ready: ${RELEASE_BUNDLE} + ${RELEASE_MANIFEST} (sha256 ${hex.slice(0, 12)}…)`);
  return 0;
}

/** The section body for `## [X.Y.Z]` in CHANGELOG.md, or null. */
function changelogSection(version: string): string | null {
  if (!existsSync(CHANGELOG)) return null;
  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const out: string[] = [];
  let found = false;
  for (const line of lines) {
    if (line.startsWith(`## [${version}]`)) {
      found = true;
      continue;
    }
    if (found && line.startsWith("## [")) break;
    if (found) out.push(line);
  }
  return found ? out.join("\n").trim() : null;
}

/** Move `[Unreleased]` content into a dated `[X.Y.Z]` section (notes line prepended). */
function rollChangelog(version: string, notes: string, today: string): string | null {
  const src = readFileSync(CHANGELOG, "utf8");
  const marker = "## [Unreleased]";
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const afterHeader = at + marker.length;
  const nextSection = src.indexOf("\n## [", afterHeader);
  const bodyEnd = nextSection === -1 ? src.length : nextSection;
  const unreleased = src.slice(afterHeader, bodyEnd).trim();
  const merged = [notes, unreleased].filter((s) => s !== "").join("\n\n");
  if (merged === "") return null; // nothing to release — keep the discipline loud
  const section = `${marker}\n\n## [${version}] — ${today}\n\n${merged}\n`;
  return `${src.slice(0, at)}${section}${src.slice(bodyEnd === src.length ? bodyEnd : bodyEnd + 1)}`;
}

/**
 * The one human entrypoint: `bun run release X.Y.Z "notes"`. Local side is ONLY the git
 * ceremony — guards, bump, changelog, commit, tag, push. CI builds and publishes off the
 * tag, so the tag always points at exactly the commit the assets are built from.
 */
async function doCeremony(version: string, notes: string): Promise<number> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return fail(`bad version '${version}' (expected X.Y.Z)`);
  if (compareSemver(version, VERSION) <= 0) return fail(`version ${version} must be > current ${VERSION}`);

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], true)).out;
  if (branch !== "main" && branch !== "master") return fail(`releases cut from main only (on '${branch}')`);
  const dirty = (await git(["status", "--porcelain"], true)).out;
  if (dirty !== "") return fail(`working tree is dirty — commit or stash first:\n${dirty}`);
  if ((await git(["rev-parse", "--verify", "--quiet", `refs/tags/v${version}`], true)).ok) {
    return fail(`tag v${version} already exists — releases are immutable`);
  }

  console.log("pre-gate: bun run check …");
  const check = Bun.spawn(["bun", "run", "check"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await check.exited) !== 0) return fail("check failed — nothing released");

  // bump version — targeted textual replace keeps package.json formatting untouched
  const pkg = readFileSync(PKG_JSON, "utf8");
  const bumped = pkg.replace(`"version": "${VERSION}"`, `"version": "${version}"`);
  if (bumped === pkg) return fail(`could not find "version": "${VERSION}" in package.json`);

  const today = new Date().toISOString().slice(0, 10);
  const rolled = rollChangelog(version, notes, today);
  if (rolled === null) return fail("CHANGELOG.md: no [Unreleased] content and no notes — nothing to release");

  writeFileSync(PKG_JSON, bumped);
  writeFileSync(CHANGELOG, rolled);

  const msg = notes === "" ? `${version}` : `${version}: ${notes}`;
  for (const step of [
    ["add", "package.json", "CHANGELOG.md"],
    ["commit", "-m", msg],
    ["tag", `v${version}`],
    ["push", "origin", "HEAD", `refs/tags/v${version}`],
  ]) {
    if (!(await git(step)).ok) return fail(`git ${step[0]} failed — resolve manually (tree may hold the bump)`);
  }
  console.log(`\nv${version} tagged and pushed — CI takes it from here (gate → build → publish).`);
  console.log("watch: gh run watch   ·   fleet picks the release up via releaseUrl within ~5 min");
  return 0;
}

function fail(msg: string): number {
  console.error(`release: ${msg}`);
  return 1;
}

const args = Bun.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
let code: number;
if (args.includes("--stage")) {
  code = await doStage();
} else if (args.includes("--local")) {
  code = await doLocal(positional.join(" "));
} else if (args.includes("--ci-assets")) {
  const url = positional[0];
  code = url === undefined ? fail("--ci-assets <bundle-url>") : await doCiAssets(url);
} else if (positional.length > 0 && positional[0] !== undefined) {
  code = await doCeremony(positional[0], positional.slice(1).join(" "));
} else {
  console.log("usage: bun run release X.Y.Z \"notes\"   (or: --stage · --local · --ci-assets URL)");
  code = 1;
}
process.exit(code);
