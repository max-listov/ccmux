import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalSessionSchema } from "../src/config/schema.ts";
import { discoverOne } from "../src/external/discover.ts";
import { codexOrigin, isDedicatedCodexCommand } from "../src/external/codex.ts";
import { externalSessionKey, managedSessionKey } from "../src/external/keys.ts";
import { codexThreadLockPath, lockHeldByDescendant, parseLsofHolders } from "../src/external/codexLocks.ts";
import { isDescendantProcess, parseProcessSnapshot } from "../src/external/processes.ts";
import { makeMachine } from "./helpers.ts";

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";

describe("external discovery DTO", () => {
  const row = ExternalSessionSchema.parse({
    key: `external:codex:host-a#${THREAD_A}`,
    plane: "external",
    provider: "codex",
    host: "host-a",
    threadId: THREAD_A,
    dir: "/Users/u/project",
    path: "/Users/u/.codex/sessions/rollout.jsonl",
    origin: "desktop",
    storage: "stored",
    writerEvidence: "observed",
    turnState: unknownTurnState("codex-app-server"),
    writerRuntime: {
      kind: "desktop",
      pid: 42,
      startTime: "Mon Aug 10 12:34:56 2026",
      processGroup: 40,
      reason: "writer descends from a desktop application",
    },
    capabilities: {
      inspect: true,
      attemptAdopt: false,
      fork: true,
      terminateAndAdopt: false,
      releaseAtSource: true,
      reasons: ["the live writer is shared, managed, self-owned, or has unknown ancestry"],
    },
    lastActivityMs: 1,
    lastModel: "model-a",
    usedTokens: 2,
    lastMessage: null,
  });

  test("accepts the strict provider-neutral shape", () => {
    expect(ExternalSessionSchema.parse(row)).toEqual(row);
  });

  test("rejects undeclared fields", () => {
    expect(ExternalSessionSchema.safeParse({ ...row, sessionName: "private-name" }).success).toBe(false);
  });

  test("represents a held pre-turn writer without pretending a transcript exists", () => {
    expect(ExternalSessionSchema.safeParse({
      ...row,
      storage: "missing",
      dir: null,
      path: null,
      lastActivityMs: null,
      lastModel: null,
      usedTokens: null,
    }).success).toBe(true);
    expect(ExternalSessionSchema.safeParse({ ...row, storage: "missing" }).success).toBe(false);
  });

  test("exports the fresh exact lookup API", () => {
    expect(typeof discoverOne).toBe("function");
  });
});

describe("stable keys", () => {
  test("external identity excludes mutable origin and cwd", () => {
    expect(externalSessionKey("codex", "host-a", THREAD_A)).toBe(`external:codex:host-a#${THREAD_A}`);
  });

  test("managed identity includes provider, host, registry name and thread", () => {
    expect(managedSessionKey({
      name: "agent-a",
      dir: "/Users/u/project",
      uuid: THREAD_B,
      flags: [],
      archived: false,
      resumeText: "continue",
      agent: "claude",
      chatEnabled: false,
      promptModules: [],
    }, "host-a")).toBe(`managed:claude:host-a:agent-a#${THREAD_B}`);
  });
});

describe("writer lock evidence", () => {
  const lock = `/Users/u/.codex/thread-writer-locks/${THREAD_A}.lock`;

  test("lsof parser binds a holder only to the exact lock path", () => {
    const output = [
      "p41",
      "cshared-runtime",
      "f7",
      `n/Users/u/.codex/thread-writer-locks/${THREAD_B}.lock`,
      "p42",
      "ccodex",
      "f8",
      `n${lock}`,
      "",
    ].join("\n");
    expect(parseLsofHolders(output, lock)).toEqual([{ pid: 42, command: "codex" }]);
  });

  test("process parser and descendant admission use the real ancestor chain", () => {
    const rows = parseProcessSnapshot([
      "  10     1    10 Mon Aug 10 12:00:00 2026 ccmux bootstrap",
      "  20    10    10 Mon Aug 10 12:00:01 2026 codex",
      "  30    20    10 Mon Aug 10 12:00:02 2026 helper",
    ].join("\n"));
    expect(isDescendantProcess(rows, 30, 10)).toBe(true);
    expect(isDescendantProcess(rows, 10, 10)).toBe(false);
    expect(lockHeldByDescendant({ evidence: "observed", path: lock, holders: [{ pid: 20, command: "codex" }] }, rows, 10)).toBe(true);
    // exec-style bootstrap: the lock holder may be the exact admitted pid.
    expect(lockHeldByDescendant({ evidence: "observed", path: lock, holders: [{ pid: 10, command: "codex" }] }, rows, 10)).toBe(true);
    expect(lockHeldByDescendant({ evidence: "observed", path: lock, holders: [{ pid: 30, command: "helper" }] }, rows, 99)).toBe(false);
  });

  test("canonicalizes an existing lock path to the spelling lsof reports", () => {
    const root = mkdtempSync(join(tmpdir(), "ccmux-lock-path-"));
    const lockDir = join(root, "thread-writer-locks");
    const path = join(lockDir, `${THREAD_A}.lock`);
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(path, "");
      expect(codexThreadLockPath(makeMachine({ codexHome: root }), THREAD_A)).toBe(realpathSync(path));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Codex session metadata", () => {
  test("maps structured subagent source without exposing its nested identifier", () => {
    expect(codexOrigin({
      type: "session_meta",
      timestamp: "2026-08-10T00:00:00.000Z",
      payload: {
        id: THREAD_A,
        cwd: "/Users/u/project",
        originator: "codex_exec",
        source: { subagent: { thread_spawn: { parent_thread_id: THREAD_B } } },
      },
    })).toBe("subagent");
  });

  test("keeps desktop and exec origins distinct", () => {
    expect(codexOrigin({ type: "session_meta", payload: { id: THREAD_A, originator: "Codex Desktop", source: "vscode" } })).toBe("vscode");
    expect(codexOrigin({ type: "session_meta", payload: { id: THREAD_A, originator: "codex_exec", source: "exec" } })).toBe("exec");
  });

  test("normalizes App Server spellings and keeps unknown source shapes readable", () => {
    expect(codexOrigin({ type: "session_meta", payload: { id: THREAD_A, source: "appServer" } })).toBe("app-server");
    expect(codexOrigin({ type: "session_meta", payload: { id: THREAD_A, source: 42 } })).toBe("unknown");
  });

  test("recognizes only the configured Codex executable as a dedicated CLI", () => {
    expect(isDedicatedCodexCommand("/opt/tools/codex resume thread", "/opt/tools/codex")).toBe(true);
    expect(isDedicatedCodexCommand("codex resume thread", "/opt/tools/codex")).toBe(false);
    expect(isDedicatedCodexCommand("/tmp/codex resume thread", "/opt/tools/codex")).toBe(false);
    expect(isDedicatedCodexCommand("/opt/tools/codex-host resume thread", "/opt/tools/codex")).toBe(false);
    expect(isDedicatedCodexCommand("wrapper /opt/tools/codex resume thread", "/opt/tools/codex")).toBe(false);
    expect(isDedicatedCodexCommand("code", "/opt/tools/codex")).toBe(false);
  });
});
import { unknownTurnState } from "../src/external/turnSchema.ts";
