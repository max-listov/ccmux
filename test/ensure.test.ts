import { test, expect } from "bun:test";
import { ensureOnce } from "../src/commands/ensure.ts";
import { makeSession } from "./helpers.ts";

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
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  expect(started).toEqual([]);
});
