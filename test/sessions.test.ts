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

test("v2 requires JSON rows with an explicit agent", () => {
  const dir = tmpStateDir();
  const m = makeMachine({ stateDir: dir });
  writeFileSync(sessionsPath(m), `# header\n\n{"name":"cc-json","dir":"/home/user","uuid":"${UUID}","agent":"codex"}\n`);
  expect(loadSessions(m)[0]?.agent).toBe("codex");
  writeFileSync(sessionsPath(m), `cc-legacy|/home/user|${UUID}\n`);
  expect(() => loadSessions(m)).toThrow(/expected JSON with explicit agent/);
});

test("removeSession filters exact name only — never a longer sibling", async () => {
  const m = makeMachine({ stateDir: tmpStateDir() });
  await appendSession(m, makeSession({ name: "cc-x" }));
  await appendSession(m, makeSession({ name: "cc-x-staging", uuid: "22222222-2222-4222-8222-222222222222" }));
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
