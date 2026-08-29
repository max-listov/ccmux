import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { makeMachine, makeSession, UUID } from "./helpers.ts";
import { ownedCodexSocket, privateRuntimeDirectory } from "../src/agent/codex/ownedPaths.ts";
import { OwnedCodexConnection } from "../src/agent/codex/ownedConnection.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";
import { OWNED_CODEX_OMIT_NOTIFICATIONS } from "../src/agent/codex/ownedRpc.ts";
import { supportsOwnedCodexVersion } from "../src/agent/codex/ownedLaunch.ts";
import { readEvents } from "../src/events/feed.ts";
import { nativeResponseFingerprint, readNativeReceipt, writeNativeCommand } from "../src/agent/codex/ownedControl.ts";

function fixture(publication: "none" | "delayed" | "empty" | "malformed" = "none") {
  const codexSessionsDir = mkdtempSync("/tmp/ccmux-native-rollouts-");
  const m = makeMachine({
    stateDir: mkdtempSync("/tmp/ccmux-native-connection-"),
    codexSessionsDir,
    codexCorrelationTimeoutMs: 150,
    sessionEvents: true,
  });
  const s = makeSession({ agent: "codex", runtime: "app-server", eventsEnabled: true });
  const path = ownedCodexSocket(m, s.name); privateRuntimeDirectory(dirname(path));
  let client: ServerWebSocket<unknown> | null = null;
  let admissionRace = true, readRace = true, wrongIdentity = false;
  let native: unknown = { type: "idle" };
  const requests: string[] = [];
  const turnMessageIds: string[] = [];
  const responses: unknown[] = [];
  const send = (method: string, params: unknown) => client?.send(JSON.stringify({ method, params }));
  const request = (id: number | string, method: string, params: unknown) => client?.send(JSON.stringify({ id, method, params }));
  const turn = (status: string) => ({ threadId: s.uuid, turn: { id: "turn-a", status } });
  const server = Bun.serve<unknown>({ unix: path,
    fetch(request, server) { if (server.upgrade(request, { data: undefined })) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { client = ws; },
      message(ws, raw) {
        const decoded = JSON.parse(String(raw));
        if (decoded.method === undefined) { responses.push(decoded); return; }
        const message = z.object({ id: z.number().optional(), method: z.string(), params: z.unknown() }).parse(decoded);
        requests.push(message.method);
        const respond = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
        if (message.method === "initialize") {
          expect(message.params).toMatchObject({ capabilities: { experimentalApi: true, optOutNotificationMethods: OWNED_CODEX_OMIT_NOTIFICATIONS } });
          respond({ userAgent: "codex/0.147.0" });
        }
        if (message.method === "thread/start") {
          const directory = join(codexSessionsDir, "2026", "08", "29");
          mkdirSync(directory, { recursive: true });
          const rollout = join(directory, `rollout-2026-08-29T00-00-00-${s.uuid}.jsonl`);
          writeFileSync(rollout, publication === "malformed" ? "{broken}\n" : "");
          if (publication === "delayed") {
            setTimeout(() => writeFileSync(rollout, `${JSON.stringify({
              type: "session_meta",
              payload: { id: s.uuid, originator: "test" },
            })}\n`), 40);
          }
          respond({ thread: { id: s.uuid, name: null, source: "cli", status: native, canAcceptDirectInput: true } });
        }
        if (message.method === "turn/start") {
          turnMessageIds.push(z.object({ clientUserMessageId: z.string() }).parse(message.params).clientUserMessageId);
          const rollout = join(codexSessionsDir, "2026", "08", "29", `rollout-2026-08-29T00-00-00-${s.uuid}.jsonl`);
          const committed = readFileSync(rollout, "utf8").includes('"type":"session_meta"');
          if (!committed) ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "thread-store internal error: rollout is empty" } }));
          else respond({ turn: { id: "bootstrap-turn" } });
        }
        if (message.method === "thread/resume" || message.method === "thread/read") {
          if (message.method === "thread/resume" && admissionRace) { send("turn/started", turn("inProgress")); admissionRace = false; }
          if (message.method === "thread/read" && readRace) {
            send("thread/status/changed", { threadId: s.uuid, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
            readRace = false;
          }
          respond({ thread: { id: wrongIdentity ? crypto.randomUUID() : s.uuid, name: null, source: "cli", status: native, canAcceptDirectInput: true } });
        }
        if (message.method === "thread/turns/list") respond({ data: [{ id: "turn-a", status: "inProgress" }] });
      },
    },
  });
  return { m, s, requests, responses, turnMessageIds, send, request, turn,
    setNative(value: unknown) { native = value; },
    mismatch() { wrongIdentity = true; },
    disconnect() { client?.close(); }, close() { server.stop(true); },
  };
}

test("fresh admission retries the named empty-rollout failure only after committed session_meta", async () => {
  const f = fixture("delayed"), connection = new OwnedCodexConnection(f.m, f.s, process.pid);
  try {
    await connection.open(new AbortController().signal);
    await connection.admit(true, new AbortController().signal);
    expect(f.requests.indexOf("thread/start")).toBeLessThan(f.requests.indexOf("turn/start"));
    expect(f.requests.filter((method) => method === "turn/start")).toHaveLength(2);
    expect(f.turnMessageIds).toEqual([f.s.uuid, f.s.uuid]);
  } finally { await connection.close("stopped"); f.close(); }
});

for (const publication of ["empty", "malformed"] satisfies Array<"empty" | "malformed">) {
  test(`fresh admission fails boundedly when rollout metadata stays ${publication}`, async () => {
    const f = fixture(publication), connection = new OwnedCodexConnection(f.m, f.s, process.pid);
    try {
      await connection.open(new AbortController().signal);
      await expect(connection.admit(true, new AbortController().signal)).rejects.toThrow(
        "rollout metadata did not become readable",
      );
      expect(f.requests.filter((method) => method === "turn/start")).toHaveLength(1);
    } finally { await connection.close("stopped"); f.close(); }
  });
}

test("native subscription precedes snapshots, reconnect changes generation and retired connections cannot replay history", async () => {
  const f = fixture();
  const first = new OwnedCodexConnection(f.m, f.s, process.pid);
  let next: OwnedCodexConnection | null = null;
  try {
    await first.open(new AbortController().signal); await first.admit(false, new AbortController().signal);
    const baseline = readOwnedCodexStatus(f.m, f.s);
    expect(baseline.snapshot).toMatchObject({ state: "waiting-approval", turn: { id: "turn-a", status: "inProgress" } });
    expect(readEvents(f.m)).toEqual([]); // no history notifications at admission
    first.activateEvents(f.s);
    f.send("turn/completed", f.turn("completed"));
    const deadline = Date.now() + 2000;
    while (readOwnedCodexStatus(f.m, f.s).snapshot?.turn?.status !== "completed" && Date.now() < deadline) await Bun.sleep(5);
    expect(readOwnedCodexStatus(f.m, f.s).snapshot?.turn?.status).toBe("completed");
    expect(readEvents(f.m).map(({ event, threadId }) => ({ event, threadId }))).toEqual([{ event: "turn-end", threadId: UUID }]);
    f.disconnect();
    await Bun.sleep(20);
    await expect(first.refresh(f.s)).rejects.toThrow();
    await first.close("disconnected");
    expect(readOwnedCodexStatus(f.m, f.s).status).toBe("unavailable");
    next = new OwnedCodexConnection(f.m, f.s, process.pid);
    await next.open(new AbortController().signal); await next.admit(false, new AbortController().signal);
    const resumed = readOwnedCodexStatus(f.m, f.s);
    expect(resumed.status).toBe("live"); expect(resumed.snapshot?.generation).not.toBe(baseline.snapshot?.generation);
    expect(resumed.snapshot?.state).toBe("idle");
    await first.close("late-retired-close");
    expect(readOwnedCodexStatus(f.m, f.s).snapshot?.generation).toBe(resumed.snapshot?.generation);
    expect(f.requests.filter((method) => method === "thread/resume")).toHaveLength(2);
    expect(f.requests).not.toContain("thread/start"); expect(f.requests).not.toContain("turn/start");
    expect(readEvents(f.m)).toHaveLength(1);
  } finally { await first.close("stopped"); await next?.close("stopped"); f.close(); }
});

test("mismatched native resume and malformed active flags never admit an idle replacement", async () => {
  const f = fixture(), connection = new OwnedCodexConnection(f.m, f.s, process.pid);
  try {
    await connection.open(new AbortController().signal);
    f.mismatch();
    await expect(connection.admit(false, new AbortController().signal)).rejects.toThrow("different thread identity");
    expect(readOwnedCodexStatus(f.m, f.s).status).toBe("unavailable");
    expect(f.requests).not.toContain("thread/start");
  } finally { await connection.close("stopped"); f.close(); }
  const malformed = fixture(), second = new OwnedCodexConnection(malformed.m, malformed.s, process.pid);
  try {
    malformed.setNative({ type: "active" });
    await second.open(new AbortController().signal);
    await expect(second.admit(false, new AbortController().signal)).rejects.toThrow();
    expect(readOwnedCodexStatus(malformed.m, malformed.s).status).toBe("unavailable");
  } finally { await second.close("stopped"); malformed.close(); }
});

test("native version floor excludes older/unknown/floor prerelease binaries", () => {
  for (const version of ["codex-cli 0.147.0", "codex-cli 0.147.0+build.1", "codex-cli 0.150.0-alpha.8", "codex-cli 1.0.0"]) expect(supportsOwnedCodexVersion(version)).toBe(true);
  for (const version of ["unknown", "codex-cli 0.146.0", "codex-cli 0.147.0-alpha.1", "codex-cli 0.150.0-..", "codex-cli 0.150.0invalid"]) expect(supportsOwnedCodexVersion(version)).toBe(false);
});

test("approval and input responses stay on the owning RPC connection and reject stale projection generations", async () => {
  const f = fixture(), connection = new OwnedCodexConnection(f.m, f.s, process.pid);
  try {
    await connection.open(new AbortController().signal); await connection.admit(false, new AbortController().signal);
    f.request("approval-1", "item/commandExecution/requestApproval", { threadId: f.s.uuid, turnId: "turn-a",
      itemId: "command-a", startedAtMs: Date.now(), reason: "needs permission", availableDecisions: ["accept", "decline"] });
    for (let i = 0; i < 100 && readOwnedCodexStatus(f.m, f.s).snapshot?.pendingRequests.length !== 1; i++) await Bun.sleep(5);
    const approval = readOwnedCodexStatus(f.m, f.s).snapshot!;
    expect(approval.pendingRequests[0]).toMatchObject({ requestId: "s:approval-1", kind: "approval", decisions: ["accept", "decline"] });
    const approvalCommand = { operationId: crypto.randomUUID(), generation: approval.generation,
      requestId: "s:approval-1", kind: "approval" as const, decision: "accept" as const, answers: null };
    await writeNativeCommand(f.m, f.s.name, { ...approvalCommand, fingerprint: nativeResponseFingerprint(approvalCommand) });
    await connection.applyControlResponse();
    for (let i = 0; i < 100 && f.responses.length === 0; i++) await Bun.sleep(5);
    expect(f.responses.at(-1)).toEqual({ id: "approval-1", result: { decision: "accept" } });
    expect(readNativeReceipt(f.m, f.s.name)).toMatchObject({ outcome: "submitted", requestId: "s:approval-1" });
    expect(readOwnedCodexStatus(f.m, f.s).snapshot?.pendingRequests).toEqual([]);

    f.request(42, "item/tool/requestUserInput", { threadId: f.s.uuid, turnId: "turn-a", itemId: "input-a",
      isBlocking: true, autoResolutionMs: null, questions: [{ id: "choice", header: "Choice", question: "Pick one",
        isOther: false, isSecret: false, options: [{ label: "A", description: "first" }] }] });
    for (let i = 0; i < 100 && readOwnedCodexStatus(f.m, f.s).snapshot?.pendingRequests.length !== 1; i++) await Bun.sleep(5);
    const input = readOwnedCodexStatus(f.m, f.s).snapshot!;
    const inputCommand = { operationId: crypto.randomUUID(), generation: input.generation,
      requestId: "n:42", kind: "input" as const, decision: null, answers: { choice: ["A"] } };
    await writeNativeCommand(f.m, f.s.name, { ...inputCommand, fingerprint: nativeResponseFingerprint(inputCommand) });
    await connection.applyControlResponse();
    for (let i = 0; i < 100 && f.responses.length < 2; i++) await Bun.sleep(5);
    expect(f.responses.at(-1)).toEqual({ id: 42, result: { answers: { choice: { answers: ["A"] } } } });

    const before = f.responses.length;
    const staleCommand = { operationId: crypto.randomUUID(), generation: crypto.randomUUID(),
      requestId: "n:42", kind: "input" as const, decision: null, answers: { choice: ["A"] } };
    await writeNativeCommand(f.m, f.s.name, { ...staleCommand, fingerprint: nativeResponseFingerprint(staleCommand) });
    await connection.applyControlResponse();
    expect(f.responses).toHaveLength(before);
    expect(readNativeReceipt(f.m, f.s.name)).toMatchObject({ outcome: "rejected", reason: "projection-generation-mismatch" });
  } finally { await connection.close("stopped"); f.close(); }
});
