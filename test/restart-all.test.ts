import { test, expect } from "bun:test";
import type { Session } from "../src/types.ts";
import { restartAllOnce, type RestartAllDeps } from "../src/commands/restartAll.ts";
import { makeSession } from "./helpers.ts";

// The fleet sweep behind `ccmux restart --all` / TUI `R`. The load-bearing property is ORDER: every
// session is killed AND started before the next one is touched, so at most one session is ever down —
// that's what keeps the tmux server from emptying (it dies with its last session) and keeps the
// daemon from seeing a fleet-wide outage.

const keepPin = (s: Session): Promise<Session> => Promise.resolve(s);

function trace(over: Partial<RestartAllDeps> = {}): { deps: RestartAllDeps; log: string[] } {
  const log: string[] = [];
  const deps: RestartAllDeps = {
    sessions: () => [makeSession({ name: "cc-a" }), makeSession({ name: "cc-b" })],
    self: undefined,
    followFork: keepPin,
    kill: (name) => {
      log.push(`kill:${name}`);
      return Promise.resolve();
    },
    writersGone: (uuid) => {
      log.push(`gate:${uuid.slice(0, 4)}`);
      return Promise.resolve();
    },
    start: (name) => {
      log.push(`start:${name}`);
      return Promise.resolve();
    },
    ...over,
  };
  return { deps, log };
}

test("one session at a time: kill → writer-gate → start, fully, before the next is touched", async () => {
  const { deps, log } = trace();
  await restartAllOnce(deps);
  expect(log).toEqual(["kill:cc-a", "gate:1111", "start:cc-a", "kill:cc-b", "gate:1111", "start:cc-b"]);
  // the invariant, stated as an assertion: no second kill before the previous start
  const killIdx = log.indexOf("kill:cc-b");
  expect(log.indexOf("start:cc-a")).toBeLessThan(killIdx);
});

test("the calling session is restarted LAST (its own pane dies and comes back)", async () => {
  const { deps, log } = trace({
    sessions: () => [makeSession({ name: "cc-a" }), makeSession({ name: "cc-self" }), makeSession({ name: "cc-b" })],
    self: "cc-self",
  });
  const done = await restartAllOnce(deps);
  expect(done).toEqual(["cc-a", "cc-b", "cc-self"]);
  expect(log[log.length - 1]).toBe("start:cc-self");
});

test("archived sessions are skipped (they are parked on purpose)", async () => {
  const { deps, log } = trace({
    sessions: () => [makeSession({ name: "cc-a" }), makeSession({ name: "cc-arch", archived: true })],
  });
  const done = await restartAllOnce(deps);
  expect(done).toEqual(["cc-a"]);
  expect(log.some((l) => l.includes("cc-arch"))).toBe(false);
});

test("follow-the-fork runs BEFORE each restart, and the re-pinned uuid is what gets gated/started", async () => {
  const followed: string[] = [];
  const forked = "22222222-2222-4222-8222-222222222222";
  const { deps, log } = trace({
    sessions: () => [makeSession({ name: "cc-a" })],
    followFork: (s) => {
      followed.push(s.name);
      return Promise.resolve({ ...s, uuid: forked });
    },
  });
  await restartAllOnce(deps);
  expect(followed).toEqual(["cc-a"]);
  expect(log).toEqual(["kill:cc-a", "gate:2222", "start:cc-a"]); // gate keyed on the CURRENT uuid
});

test("an empty / all-archived fleet is a clean no-op", async () => {
  const { deps, log } = trace({ sessions: () => [] });
  expect(await restartAllOnce(deps)).toEqual([]);
  expect(log).toEqual([]);
});

test("progress is reported per session, in order", async () => {
  const seen: string[] = [];
  const { deps } = trace({ onProgress: (done, total, name) => seen.push(`${done}/${total}:${name}`) });
  await restartAllOnce(deps);
  expect(seen).toEqual(["1/2:cc-a", "2/2:cc-b"]);
});
