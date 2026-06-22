#!/usr/bin/env bun
// DEV release tooling — runs ONLY from the source checkout (package.json scripts). This is
// NOT part of the `ccmux` tool that ships to the fleet: clients have a bundle, no repo, no
// package.json, so they can never build or publish a release. Like `npm publish`.
//
//   bun run stage            → build bundle → ~/.ccmux/staged (for local `ccmux update` test)
//   bun run release          → build bundle + local file:// manifest (~/.ccmux/releases)
//   bun run release:publish  → build + push to GitHub Releases (tag vX.Y.Z, 3 assets)
//
// The fleet consumes the published manifest via machine.json `releaseUrl` + autoUpdate.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASES_DIR, RELEASE_BUNDLE, RELEASE_MANIFEST, STAGED_BUNDLE } from "../src/config/paths.ts";
import { VERSION } from "../src/util/version.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_CLI = join(ROOT, "src", "cli.ts");
const INSTALL_SCRIPT = join(ROOT, "scripts", "install.sh");

type Mode = "stage" | "local" | "publish";

async function bundle(outfile: string): Promise<boolean> {
  mkdirSync(dirname(outfile), { recursive: true });
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

async function gh(argv: string[], capture = false): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(["gh", ...argv], { stdout: capture ? "pipe" : "inherit", stderr: capture ? "pipe" : "inherit" });
    const out = capture ? (await new Response(proc.stdout).text()).trim() : "";
    return { ok: (await proc.exited) === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

async function doStage(): Promise<number> {
  if (!(await bundle(STAGED_BUNDLE))) return fail("build failed");
  console.log(`staged v${VERSION} → ${STAGED_BUNDLE}`);
  console.log("apply locally: ccmux update");
  return 0;
}

async function doLocal(notes: string): Promise<number> {
  mkdirSync(RELEASES_DIR, { recursive: true });
  if (!(await bundle(RELEASE_BUNDLE))) return fail("build failed");
  const { bytes, hex } = sha256(RELEASE_BUNDLE);
  await writeManifest(`file://${RELEASE_BUNDLE}`, notes);
  console.log(`built v${VERSION} → ${RELEASE_MANIFEST} (${(bytes / 1e6).toFixed(2)} MB, sha256 ${hex.slice(0, 12)}…)`);
  console.log(`  point machine.json releaseUrl at: file://${RELEASE_MANIFEST}`);
  return 0;
}

async function doPublish(notes: string): Promise<number> {
  if (!(await gh(["--version"], true)).ok) return fail("gh CLI not found (brew install gh)");
  const repo = (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], true)).out;
  if (!repo) return fail("could not resolve GitHub repo (run in the repo, gh authed)");

  const tag = `v${VERSION}`;
  if ((await gh(["release", "view", tag, "--repo", repo], true)).ok) {
    return fail(`${tag} already exists on ${repo} — releases are immutable; bump version in package.json`);
  }

  // url must point at the VERSIONED asset so manifest+bundle are an atomic pair (no latest race)
  mkdirSync(RELEASES_DIR, { recursive: true });
  if (!(await bundle(RELEASE_BUNDLE))) return fail("build failed");
  await writeManifest(`https://github.com/${repo}/releases/download/${tag}/ccmux.js`, notes);

  const assets = [RELEASE_BUNDLE, RELEASE_MANIFEST, ...(existsSync(INSTALL_SCRIPT) ? [INSTALL_SCRIPT] : [])];
  // draft → upload all assets → publish: the release appears atomically, fleet never sees a half-upload
  if (!(await gh(["release", "create", tag, "--repo", repo, "--title", tag, "--notes", notes || `ccmux ${tag}`, "--draft", ...assets])).ok) {
    return fail("gh release create (draft) failed");
  }
  if (!(await gh(["release", "edit", tag, "--repo", repo, "--draft=false"])).ok) {
    return fail(`draft uploaded but publish failed — finish: gh release edit ${tag} --draft=false`);
  }
  console.log(`\npublished ${tag} → https://github.com/${repo}/releases/tag/${tag}`);
  console.log(`  fleet releaseUrl: https://github.com/${repo}/releases/latest/download/release.json`);
  console.log(`  new client: curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | bash`);
  return 0;
}

function fail(msg: string): number {
  console.error(`release: ${msg}`);
  return 1;
}

const args = Bun.argv.slice(2);
const mode: Mode = args.includes("--stage") ? "stage" : args.includes("--publish") ? "publish" : "local";
const notes = args.filter((a) => !a.startsWith("--")).join(" ");
process.exit(await (mode === "stage" ? doStage() : mode === "publish" ? doPublish(notes) : doLocal(notes)));
