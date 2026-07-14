import { test, expect } from "bun:test";
import type { Session } from "../src/types.ts";
import { ensureOnce } from "../src/commands/ensure.ts";
import { makeSession } from "./helpers.ts";

const keepPin = (s: Session): Promise<Session> => Promise.resolve(s);

test("ensureOnce starts only down, non-archived sessions; re-reads each call", () => {
  let sessionList = [
    makeSession({ name: "cc-a" }),
    makeSession({ name: "cc-b" }),
    makeSession({ name: "cc-arch", archived: true }),
  ];
  const started: string[] = [];
  let reads = 0;

  const deps = {
    sessions: () => {
      reads += 1;
      return sessionList;
    },
    // reflects reality: cc-a is up, and anything we start becomes running
    listRunning: () => Promise.resolve(new Set<string>(["cc-a", ...started])),
    followFork: keepPin,
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  };

  return ensureOnce(deps).then(() => {
    expect(started).toEqual(["cc-b"]); // cc-a running, cc-arch archived → only cc-b
    expect(reads).toBe(1);
    // a fresh session added externally is picked up next call — proves no caching
    sessionList = [...sessionList, makeSession({ name: "cc-new" })];
    return ensureOnce(deps).then(() => {
      expect(started).toEqual(["cc-b", "cc-new"]);
    });
  });
});

test("ensureOnce is a no-op when everything is running", async () => {
  const started: string[] = [];
  await ensureOnce({
    sessions: () => [makeSession({ name: "cc-a" })],
    listRunning: () => Promise.resolve(new Set(["cc-a"])),
    followFork: keepPin,
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  expect(started).toEqual([]);
});

test("ensureOnce follows forks on EVERY pass (running sessions too), before the start decision", async () => {
  const followed: string[] = [];
  const started: string[] = [];
  await ensureOnce({
    sessions: () => [
      makeSession({ name: "cc-up" }),
      makeSession({ name: "cc-down" }),
      makeSession({ name: "cc-arch", archived: true }),
    ],
    listRunning: () => Promise.resolve(new Set(["cc-up"])),
    followFork: (s) => {
      followed.push(s.name);
      return Promise.resolve(s);
    },
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  // running sessions are re-pinned too (their NEXT restart must resume the fork);
  // archived stay untouched; the down session is started only after its fork check
  expect(followed).toEqual(["cc-up", "cc-down"]);
  expect(started).toEqual(["cc-down"]);
});
