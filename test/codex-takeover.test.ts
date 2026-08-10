import { describe, expect, test } from "bun:test";
import {
  takeoverCodexExternalWithDependencies,
  type CodexTakeoverDependencies,
} from "../src/commands/adopt.ts";
import { ExternalSessionSchema, SessionSchema } from "../src/config/schema.ts";
import type { ExternalSession, WriterRuntime } from "../src/types.ts";
import { makeMachine } from "./helpers.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";

function external(kind: WriterRuntime["kind"], terminateAndAdopt: boolean, pid = 42): ExternalSession {
  return ExternalSessionSchema.parse({
    key: `external:codex:host-a#${THREAD}`,
    plane: "external",
    provider: "codex",
    host: "host-a",
    threadId: THREAD,
    dir: "/workspace/project",
    path: "/state/rollout.jsonl",
    origin: kind === "app-server" ? "app-server" : kind === "desktop" ? "desktop" : "cli",
    storage: "stored",
    writerEvidence: "observed",
    writerRuntime: { kind, pid, startTime: "start-a", processGroup: 40, reason: `writer is ${kind}` },
    capabilities: {
      inspect: true,
      attemptAdopt: false,
      fork: true,
      terminateAndAdopt,
      releaseAtSource: !terminateAndAdopt,
      reasons: [terminateAndAdopt ? "dedicated CLI can be terminated after confirmation" : "release at source"],
    },
    lastActivityMs: 1,
    lastModel: null,
    usedTokens: null,
    lastMessage: null,
  });
}

function dependencies(overrides: Partial<CodexTakeoverDependencies>): CodexTakeoverDependencies {
  let now = 0;
  return {
    resolve: () => { throw new Error("unexpected resolve"); },
    signal: () => { throw new Error("unexpected signal"); },
    snapshot: () => [],
    sleep: async (ms) => { now += ms; },
    now: () => now,
    adopt: async () => SessionSchema.parse({ name: "cc-adopted", dir: "/workspace/project", uuid: THREAD, agent: "codex" }),
    ...overrides,
  };
}

describe("Codex external takeover", () => {
  const machine = makeMachine({ codexBin: "/opt/tools/codex", rcPrefix: "host-a" });

  test("signals a freshly revalidated dedicated CLI once, then adopts the same UUID", async () => {
    const before = external("dedicated-cli", true);
    let resolves = 0;
    const signaled: number[] = [];
    const adopted: string[] = [];
    const result = await takeoverCodexExternalWithDependencies(machine, THREAD, 42, "cc-adopted", dependencies({
      resolve: () => {
        resolves += 1;
        return before;
      },
      signal: (pid) => { signaled.push(pid); },
      adopt: async (_machine, _dir, threadId) => {
        adopted.push(threadId);
        return SessionSchema.parse({ name: "cc-adopted", dir: "/workspace/project", uuid: threadId, agent: "codex" });
      },
    }));
    expect(result).toBe("cc-adopted");
    expect(resolves).toBe(2);
    expect(signaled).toEqual([42]);
    expect(adopted).toEqual([THREAD]);
  });

  test("fails closed before signaling shared, Desktop, App Server, self, and unknown writers", async () => {
    const kinds: WriterRuntime["kind"][] = ["shared", "desktop", "vscode", "app-server", "self", "unknown"];
    for (const kind of kinds) {
      let signals = 0;
      await expect(takeoverCodexExternalWithDependencies(machine, THREAD, 42, undefined, dependencies({
        resolve: () => external(kind, false),
        signal: () => { signals += 1; },
      }))).rejects.toThrow("not a proven dedicated CLI");
      expect(signals).toBe(0);
    }
  });

  test("aborts on PID reuse or changed process evidence before signaling", async () => {
    const before = external("dedicated-cli", true);
    const changed = ExternalSessionSchema.parse({
      ...before,
      writerRuntime: { ...before.writerRuntime, pid: 43, startTime: "start-b" },
    });
    let resolves = 0;
    let signals = 0;
    await expect(takeoverCodexExternalWithDependencies(machine, THREAD, 42, undefined, dependencies({
      resolve: () => {
        resolves += 1;
        return resolves === 1 ? before : changed;
      },
      signal: () => { signals += 1; },
    }))).rejects.toThrow("evidence changed");
    expect(signals).toBe(0);
  });

  test("does not adopt when the exact signaled process remains alive", async () => {
    const before = external("dedicated-cli", true);
    let adopted = false;
    await expect(takeoverCodexExternalWithDependencies(machine, THREAD, 42, undefined, dependencies({
      resolve: () => before,
      signal: () => {},
      snapshot: () => [{ pid: 42, ppid: 1, processGroup: 40, startTime: "start-a", command: "/opt/tools/codex resume" }],
      adopt: async () => {
        adopted = true;
        return SessionSchema.parse({ name: "unreachable", dir: "/workspace/project", uuid: THREAD, agent: "codex" });
      },
    }))).rejects.toThrow("did not exit");
    expect(adopted).toBe(false);
  });

  test("surfaces a contender that wins after SIGTERM without registering a takeover", async () => {
    const before = external("dedicated-cli", true);
    let signals = 0;
    await expect(takeoverCodexExternalWithDependencies(machine, THREAD, 42, undefined, dependencies({
      resolve: () => before,
      signal: () => { signals += 1; },
      snapshot: () => [],
      adopt: async () => { throw new Error("resume admission rejected by respawned writer"); },
    }))).rejects.toThrow("respawned writer");
    expect(signals).toBe(1);
  });
});
