import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgv } from "../src/agent/codex/launch.ts";
import { detectFork } from "../src/agent/codex/fork.ts";
import { historyFile } from "../src/agent/codex/resume.ts";
import { makeMachine, makeSession } from "./helpers.ts";

const codexMachine = (over: Record<string, unknown> = {}) =>
  makeMachine({ codexBin: "/opt/codex/codex", ...over });

test("first launch injects the management prompt as the positional PROMPT (no --session-id exists)", () => {
  const argv = buildArgv(makeSession({ agent: "codex", name: "cc-api" }), codexMachine(), "ccmux", false);
  expect(argv[0]).toBe("/opt/codex/codex");
  expect(argv).not.toContain("resume");
  // the prompt is the trailing positional and carries ccmux's management instructions + the name
  const prompt = argv[argv.length - 1] ?? "";
  expect(prompt).toContain("managed by ccmux");
  expect(prompt).toContain("cc-api");
});

test("resume launches `codex resume <uuid>` and NEVER re-injects the prompt", () => {
  const s = makeSession({ agent: "codex", uuid: "abcdef01-1111-4111-8111-111111111111" });
  const argv = buildArgv(s, codexMachine(), "ccmux", true);
  expect(argv.slice(0, 3)).toEqual(["/opt/codex/codex", "resume", s.uuid]);
  expect(argv.some((a) => a.includes("managed by ccmux"))).toBe(false);
});

test("flags survive verbatim, extraFlags come after session flags", () => {
  const s = makeSession({ agent: "codex", flags: ["-m", "gpt-5.6-sol"] });
  const argv = buildArgv(s, codexMachine({ extraFlags: ["--search"] }), "ccmux", true);
  expect(argv).toContain("gpt-5.6-sol");
  expect(argv.indexOf("-m")).toBeLessThan(argv.indexOf("--search"));
});

// ── detectFork reconcile ────────────────────────────────────────────────────────────────

function rollout(root: string, ymd: string, id: string, cwd: string): void {
  const dir = join(root, ymd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-30T00-00-00-${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { session_id: id, cwd } })}\n`);
}

const CODEX_ID = "019f7a53-8aa1-7e63-bc1d-5d2c9fdbb236";

test("detectFork reconciles Codex's self-assigned id from the fresh rollout in this cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-codex-"));
  rollout(root, "2026/07/30", CODEX_ID, "/home/user");
  const s = makeSession({ agent: "codex", dir: "/home/user" }); // uuid is still the placeholder
  const m = codexMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).toBeNull(); // placeholder has no rollout
  expect(detectFork(s, m, "", new Set())).toBe(CODEX_ID);
});

test("detectFork ignores rollouts from a different cwd and ids owned by other sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-codex-"));
  rollout(root, "2026/07/30", CODEX_ID, "/somewhere/else");
  const s = makeSession({ agent: "codex", dir: "/home/user" });
  const m = codexMachine({ codexSessionsDir: root });
  expect(detectFork(s, m, "", new Set())).toBeNull(); // wrong cwd
  // right cwd but the id is already taken by a sibling → not claimed
  rollout(root, "2026/07/30", "aaaaaaaa-1111-4111-8111-111111111111", "/home/user");
  expect(detectFork(s, m, "", new Set(["aaaaaaaa-1111-4111-8111-111111111111"]))).toBeNull();
});

test("detectFork short-circuits once reconciled (the pin already has its rollout)", () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-codex-"));
  rollout(root, "2026/07/30", CODEX_ID, "/home/user");
  const s = makeSession({ agent: "codex", dir: "/home/user", uuid: CODEX_ID }); // already reconciled
  const m = codexMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).not.toBeNull();
  expect(detectFork(s, m, "", new Set())).toBeNull();
});
