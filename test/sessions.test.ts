import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessions, appendSession, removeSession } from "../src/config/sessions.ts";
import { makeMachine, makeSession, UUID } from "./helpers.ts";
import { sessionsPath } from "../src/config/paths.ts";

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "ccmux-sess-"));
}

test("append → load round-trip (JSONL)", async () => {
  const m = makeMachine({ stateDir: tmpStateDir() });
  await appendSession(m, makeSession({ name: "cc-a" }));
  expect(loadSessions(m).map((s) => s.name)).toEqual(["cc-a"]);
});

test("blank + comment lines skipped; legacy name|dir|uuid tolerated with defaults", () => {
  const dir = tmpStateDir();
  const m = makeMachine({ stateDir: dir });
  writeFileSync(sessionsPath(m), `# header\n\ncc-legacy|/home/user|${UUID}\n{"name":"cc-json","dir":"/home/user","uuid":"${UUID}"}\n`);
  const loaded = loadSessions(m);
  expect(loaded.map((s) => s.name)).toEqual(["cc-legacy", "cc-json"]);
  expect(loaded[0]?.resumeText).toBe("continue"); // defaults applied to legacy line
});

test("removeSession filters exact name only — never a longer sibling", async () => {
  const m = makeMachine({ stateDir: tmpStateDir() });
  await appendSession(m, makeSession({ name: "cc-x" }));
  await appendSession(m, makeSession({ name: "cc-x-staging" }));
  expect(await removeSession(m, "cc-x")).toBe(true);
  expect(loadSessions(m).map((s) => s.name)).toEqual(["cc-x-staging"]);
  expect(await removeSession(m, "cc-missing")).toBe(false);
});

test("duplicate append throws a clear message", async () => {
  const m = makeMachine({ stateDir: tmpStateDir() });
  await appendSession(m, makeSession({ name: "cc-x" }));
  await expect(appendSession(m, makeSession({ name: "cc-x" }))).rejects.toThrow("already in");
});

test("loadSessions re-reads fresh — no caching (the daemon bugfix)", async () => {
  const m = makeMachine({ stateDir: tmpStateDir() });
  expect(loadSessions(m)).toEqual([]);
  await appendSession(m, makeSession({ name: "cc-late" }));
  expect(loadSessions(m).map((s) => s.name)).toEqual(["cc-late"]);
});
