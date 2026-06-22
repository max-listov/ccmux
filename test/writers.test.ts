import { test, expect } from "bun:test";
import { addEnvSelf, classifyWriters, parsePs, type PsProc, type Writer } from "../src/agent/claude/writers.ts";

const UUID = "4e117aea-caf4-4502-aab6-6da088b0345b";

// Snapshot mirroring the REAL 2026-06-10 fork incident: desktop launcher + desktop app +
// a ccmux tmux cli instance, all resuming one uuid, plus unrelated processes.
const PROCS: PsProc[] = [
  { pid: 13456, ppid: 95593, command: `/Applications/Claude.app/Contents/Helpers/disclaimer /Users/user/Library/Application Support/Claude/claude-code/2.1.165/claude.app/Contents/MacOS/claude --output-format stream-json --resume ${UUID}` },
  { pid: 13457, ppid: 13456, command: `/Users/user/Library/Application Support/Claude/claude-code/2.1.165/claude.app/Contents/MacOS/claude --output-format stream-json --resume ${UUID}` },
  { pid: 89360, ppid: 89342, command: `/Users/user/.local/bin/claude --resume ${UUID}` },
  { pid: 1683, ppid: 1626, command: "/Users/user/.local/bin/claude --resume 99999999-9999-4999-8999-999999999999" },
  { pid: 100, ppid: 1, command: "/usr/sbin/somethingelse" },
];

test("classifyWriters: dedups the desktop launcher, classifies desktop vs cli, ignores other uuids", () => {
  const w = classifyWriters(PROCS, UUID, 99999 /* unrelated self */);
  expect(w.length).toBe(2); // launcher dropped
  expect(w.find((x) => x.pid === 13457)?.kind).toBe("desktop");
  expect(w.find((x) => x.pid === 89360)?.kind).toBe("cli");
  expect(w.some((x) => x.pid === 13456)).toBe(false); // disclaimer launcher
  expect(w.some((x) => x.pid === 1683)).toBe(false); // different uuid
});

test("classifyWriters: a writer that is MY ancestor is 'self'", () => {
  // self chain: my bash (555) ← claude cli writer (89360)
  const procs: PsProc[] = [...PROCS, { pid: 555, ppid: 89360, command: "/bin/zsh -c something" }];
  const w = classifyWriters(procs, UUID, 555);
  expect(w.find((x) => x.pid === 89360)?.kind).toBe("self");
});

test("classifyWriters: matches --session-id too (first boot, no history yet)", () => {
  const procs: PsProc[] = [{ pid: 7, ppid: 1, command: `/Users/user/.local/bin/claude --session-id ${UUID}` }];
  expect(classifyWriters(procs, UUID, 99999).length).toBe(1);
});

test("addEnvSelf: marks the env-matched conversation as self (plain-`claude` host, no uuid on cmdline)", () => {
  const w = addEnvSelf([], UUID, UUID, 777);
  expect(w.length).toBe(1);
  expect(w[0]?.kind).toBe("self");
  expect(addEnvSelf([], UUID, "other-uuid", 777).length).toBe(0);
  expect(addEnvSelf([], UUID, undefined, 777).length).toBe(0);
  // no duplicate when a cmdline self already exists
  const existing: Writer[] = [{ pid: 1, kind: "self", command: "x" }];
  expect(addEnvSelf(existing, UUID, UUID, 777).length).toBe(1);
});

test("parsePs handles padded columns and skips garbage", () => {
  const out = `  123     1 /usr/bin/foo --bar\n 9999  123 /bin/baz\nnot a process line\n`;
  const procs = parsePs(out);
  expect(procs.length).toBe(2);
  expect(procs[0]).toEqual({ pid: 123, ppid: 1, command: "/usr/bin/foo --bar" });
});
