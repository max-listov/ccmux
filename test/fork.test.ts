import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFork, lastMessageMs } from "../src/agent/claude/fork.ts";
import { encodeDir } from "../src/agent/claude/resume.ts";
import { forkedUuid } from "../src/agent/index.ts";
import { loadSessions, updateSessionUuid } from "../src/config/sessions.ts";
import { makeMachine, makeSession } from "./helpers.ts";
import type { MachineConfig } from "../src/types.ts";

// Fixtures mirror a REAL fork observed live 2026-07-14 (e8f0→711f):
// the fork's jsonl starts with the inherited custom-title event, then copied history
// with ORIGINAL timestamps, then the live turn with fresh timestamps.

const PINNED = "e8f056d3-0000-4000-8000-000000000001";
const FORK = "711f8574-0000-4000-8000-000000000002";
const FORK2 = "9999aaaa-0000-4000-8000-000000000003";
const OTHER = "abcdef01-0000-4000-8000-000000000004";

const RC = "prod-alpha";

function title(t: string): string {
  return JSON.stringify({ type: "custom-title", customTitle: t, sessionId: FORK });
}
function msg(iso: string): string {
  return JSON.stringify({ type: "assistant", timestamp: iso, message: { content: "x" } });
}

/** A machine whose projectsDir is a temp dir, plus the session's encoded project folder. */
function setup(): { m: MachineConfig; dir: string; projDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ccmux-fork-"));
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  const projectsDir = join(root, "projects");
  const projDir = join(projectsDir, encodeDir(dir));
  mkdirSync(projDir, { recursive: true });
  const m = makeMachine({ projectsDir, sessionsFile: join(root, "sessions") });
  return { m, dir, projDir };
}

function writeJsonl(projDir: string, uuid: string, lines: string[]): void {
  writeFileSync(join(projDir, `${uuid}.jsonl`), `${lines.join("\n")}\n`);
}

describe("detectFork", () => {
  test("follows a titled fork whose messages are newer than the pinned file", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-11T01:23:45.000Z")]);
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-11T01:23:45.000Z"), msg("2026-07-14T03:50:50.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBe(FORK);
  });

  test("fork of a fork: the newest titled file wins", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-01T00:00:00.000Z")]);
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-05T00:00:00.000Z")]);
    writeJsonl(projDir, FORK2, [title(RC), msg("2026-07-10T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBe(FORK2);
  });

  test("ignores files titled for ANOTHER session sharing the same project dir", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-11T00:00:00.000Z")]);
    writeJsonl(projDir, OTHER, [title("prod-other"), msg("2026-07-14T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBeNull();
  });

  test("never claims a uuid pinned by another managed session", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-11T00:00:00.000Z")]);
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-14T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set([FORK]))).toBeNull();
  });

  test("a titled file that is NOT newer than the pin is not a move", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-14T12:00:00.000Z")]);
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-09T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBeNull();
  });

  test("stable after re-pin: once pinned to the fork, nothing newer → null (no flapping)", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-11T00:00:00.000Z")]);
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-14T00:00:00.000Z")]);
    const repinned = makeSession({ name: "cc-alpha", dir, uuid: FORK });
    expect(detectFork(repinned, m, RC, new Set())).toBeNull();
  });

  test("missing pinned file: a titled candidate still wins (conversation clearly lives there)", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, FORK, [title(RC), msg("2026-07-14T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBe(FORK);
  });

  test("missing project dir → null, never throws", () => {
    const { m } = setup();
    const s = makeSession({ name: "cc-alpha", dir: "/nowhere/at/all", uuid: PINNED });
    expect(detectFork(s, m, RC, new Set())).toBeNull();
  });
});

describe("forkedUuid (provider wiring)", () => {
  test("claude sessions detect via rc title; other sessions' pins are excluded automatically", () => {
    const { m, dir, projDir } = setup();
    writeJsonl(projDir, PINNED, [msg("2026-07-11T00:00:00.000Z")]);
    writeJsonl(projDir, FORK, [title(`${m.rcPrefix}-alpha`), msg("2026-07-14T00:00:00.000Z")]);
    const s = makeSession({ name: "cc-alpha", dir, uuid: PINNED });
    const other = makeSession({ name: "cc-other", dir, uuid: OTHER });
    expect(forkedUuid(s, m, [s, other])).toBe(FORK);
    // same fork uuid pinned by another session → excluded
    const squatter = makeSession({ name: "cc-squat", dir, uuid: FORK });
    expect(forkedUuid(s, m, [s, squatter])).toBeNull();
  });
});

describe("updateSessionUuid", () => {
  test("re-pins exactly one session, atomically, preserving the rest", async () => {
    const { m, dir } = setup();
    const a = makeSession({ name: "cc-a", dir, uuid: PINNED });
    const b = makeSession({ name: "cc-b", dir, uuid: OTHER });
    writeFileSync(m.sessionsFile, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
    expect(await updateSessionUuid(m, "cc-a", FORK)).toBe(true);
    const after = loadSessions(m);
    expect(after.find((s) => s.name === "cc-a")?.uuid).toBe(FORK);
    expect(after.find((s) => s.name === "cc-b")?.uuid).toBe(OTHER);
    expect(await updateSessionUuid(m, "cc-missing", FORK)).toBe(false);
  });
});

describe("lastMessageMs", () => {
  test("newest timestamp from the tail; null for missing/untimestamped files", () => {
    const { projDir } = setup();
    writeJsonl(projDir, PINNED, [title(RC), msg("2026-07-01T00:00:00.000Z"), msg("2026-07-02T00:00:00.000Z")]);
    expect(lastMessageMs(join(projDir, `${PINNED}.jsonl`))).toBe(Date.parse("2026-07-02T00:00:00.000Z"));
    writeJsonl(projDir, FORK, [title(RC)]);
    expect(lastMessageMs(join(projDir, `${FORK}.jsonl`))).toBeNull();
    expect(lastMessageMs(join(projDir, "missing.jsonl"))).toBeNull();
  });
});
