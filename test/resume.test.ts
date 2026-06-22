import { test, expect } from "bun:test";
import { existsSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { histFile, encodeDir, resumeArgs } from "../src/agent/claude/resume.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

test("encodeDir: EVERY non-alphanumeric char → dash (matches Claude, not just slashes)", () => {
  // non-existent dirs → realpath falls back to raw → pure char-class encode
  expect(encodeDir("/home/user/api-bot")).toBe("-home-user-api-bot");
  // the bug this locks: dots / underscores / spaces must ALSO become dash, or the jsonl
  // isn't found → resume forks onto --session-id → "already in use" loop
  expect(encodeDir("/tmp/cc.dot_test")).toBe("-tmp-cc-dot-test");
  expect(encodeDir("/home/x/my project.v2")).toBe("-home-x-my-project-v2");
});

test("histFile composes projectsDir + encoded dir + uuid.jsonl", () => {
  expect(histFile("/home/user", UUID, "/root/.claude/projects")).toBe(
    `/root/.claude/projects/-home-user/${UUID}.jsonl`,
  );
});

test("P0-4 realpath: /tmp resolves to /private/tmp on macOS (symlink)", () => {
  if (process.platform !== "darwin") return;
  // /tmp is a symlink to /private/tmp on macOS — Claude encodes the resolved path.
  expect(realpathSync("/tmp")).toBe("/private/tmp");
  expect(encodeDir("/tmp")).toBe("-private-tmp");
});

test("tripwire: histFile encoding byte-matches the real ~/.claude/projects layout", () => {
  // The one correctness coupling with Claude. If this fails, Claude changed its
  // project-dir encoding and resume is broken — fail CI loudly rather than silently
  // fork conversations onto --session-id.
  const home = "/Users/user/home";
  if (!existsSync(home)) return; // not this machine
  const encoded = encodeDir(home); // realpath-resolved
  expect(encoded).toBe("-Users-user-home");
  // cc-main runs in this dir — its project folder must exist, else encoding drifted
  if (existsSync("/Users/user/.claude/projects")) {
    expect(existsSync(`/Users/user/.claude/projects/${encoded}`)).toBe(true);
  }
  // symlinked paths resolve to the same project (Claude encodes the realpath)
  if (existsSync("/Users/user/Desktop/home")) {
    expect(encodeDir("/Users/user/Desktop/home")).toBe("-Users-user-home");
  }
});

test("resumeArgs flips on transcript existence — the whole resume contract", () => {
  const projects = mkdtempSync(join(tmpdir(), "ccmux-proj-"));
  const dir = mkdtempSync(join(tmpdir(), "ccmux-work-"));
  // first launch: no jsonl → --session-id
  expect(resumeArgs(UUID, dir, projects)).toEqual(["--session-id", UUID]);
  // create the transcript at the realpath-encoded location
  const hist = histFile(dir, UUID, projects);
  const sub = hist.slice(0, hist.lastIndexOf("/"));
  Bun.spawnSync(["mkdir", "-p", sub]);
  writeFileSync(hist, "{}\n");
  expect(resumeArgs(UUID, dir, projects)).toEqual(["--resume", UUID]);
});
