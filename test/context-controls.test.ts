import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { makeMachine, makeSession } from "./helpers.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { OwnedCodexStatusWriter } from "../src/agent/codex/ownedStatus.ts";
import { compactNativeContext, readContextOperation, refuseNativeRollback, readNativeHistory, readHistoryMailbox, writeHistoryMailbox } from "../src/context/service.ts";
import { applyContextCommands, observeContextCompletion, NativeContextPump, type NativeContextApi } from "../src/context/pump.ts";
import { assertNoContextMutation, readContextJournal } from "../src/context/store.ts";
import { boundedHistoryPage, encodeHistoryCursor, historyCursor } from "../src/context/history.ts";
import { admitNativeFork, prepareNativeFork, readNativeForkIntent } from "../src/context/fork.ts";
import { managedPeer } from "../src/chat/identity.ts";
import { codexContextApi, isCodexContextCompletion } from "../src/context/codex.ts";
import { openCodeContextApi } from "../src/context/opencode.ts";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { writeRuntimeInput } from "../src/runtime/input.ts";
import { privateRuntimeDirectory } from "../src/agent/codex/ownedPaths.ts";
import { managedRuntimeRoot } from "../src/runtime/status.ts";
import { ContentProducer } from "../src/content/producer.ts";
import { readContent } from "../src/content/read.ts";

async function fixture() {
  const root = mkdtempSync("/tmp/ccmux-context-test-");
  const m = makeMachine({ stateDir: root, rcPrefix: "host-a" });
  const s = makeSession({ agent: "codex", runtime: "app-server", registrationGeneration: crypto.randomUUID() });
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: "idle" }, 0);
  await new OwnedCodexStatusWriter(m, s.name).write(projection.snapshot());
  return { m, s, root, projection, generation: projection.snapshot().generation, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("compact ACK is not completion; same-ID retry, stale events and cursor reset are exact", async () => {
  const f = await fixture(); let calls = 0;
  const api: NativeContextApi = { history: async () => boundedHistoryPage(f.m, f.s, [], null, "complete"),
    compactionMarker: async () => null, compact: async () => { calls++; } };
  const request = { operationId: crypto.randomUUID(), generation: f.generation };
  try {
    const cursor = encodeHistoryCursor(f.m, f.s, "native-page-1");
    expect(cursor).not.toBeNull();
    expect((await compactNativeContext(f.m, f.s, request, AbortSignal.timeout(1_000))).state).toBe("queued");
    await applyContextCommands(f.m, f.s, f.generation, api, AbortSignal.timeout(1_000));
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("running");
    expect(() => assertNoContextMutation(f.m, f.s)).toThrow();
    await compactNativeContext(f.m, f.s, request, AbortSignal.timeout(1_000));
    await applyContextCommands(f.m, f.s, f.generation, api, AbortSignal.timeout(1_000));
    expect(calls).toBe(1);
    await observeContextCompletion(f.m, f.s, crypto.randomUUID());
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("running");
    await observeContextCompletion(f.m, f.s, f.generation);
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("completed");
    expect(readContextJournal(f.m, f.s).revision).toBe(1);
    expect(() => assertNoContextMutation(f.m, f.s)).not.toThrow();
    if (cursor !== null) expect(() => historyCursor(f.m, f.s, cursor)).toThrow();
    await expect(compactNativeContext(f.m, f.s, { ...request, generation: crypto.randomUUID() }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "CONTEXT_CONFLICT" });
    expect(() => refuseNativeRollback()).toThrow("Native rollback cannot guarantee");
  } finally { f.cleanup(); }
});

test("lost compact ACK survives restart without retry and reconciles only a new native marker", async () => {
  const f = await fixture(); let calls = 0, marker: string | null = "old-marker";
  const api: NativeContextApi = { history: async () => boundedHistoryPage(f.m, f.s, [], null, "complete"),
    compactionMarker: async () => marker, compact: async () => { calls++; throw new Error("private provider cause"); } };
  const request = { operationId: crypto.randomUUID(), generation: f.generation };
  try {
    await compactNativeContext(f.m, f.s, request, AbortSignal.timeout(1_000));
    await applyContextCommands(f.m, f.s, f.generation, api, AbortSignal.timeout(1_000));
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("uncertain");
    await observeContextCompletion(f.m, f.s, f.generation, "old-marker");
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("uncertain");
    const nextGeneration = crypto.randomUUID();
    await applyContextCommands(f.m, f.s, nextGeneration, api, AbortSignal.timeout(1_000));
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("uncertain");
    marker = "new-marker";
    await applyContextCommands(f.m, f.s, nextGeneration, api, AbortSignal.timeout(1_000));
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("completed");
    expect(calls).toBe(1);
  } finally { f.cleanup(); }
});

test("completed compact receipt waits for durable replay boundary and duplicates do not republish", async () => {
  const f = await fixture(); let publications = 0;
  const ready = Promise.withResolvers<void>(), published = Promise.withResolvers<void>();
  const request = { operationId: crypto.randomUUID(), generation: f.generation };
  const api: NativeContextApi = { history: async () => boundedHistoryPage(f.m, f.s, [], null, "complete"),
    compactionMarker: async () => null, compact: async () => {} };
  try {
    await compactNativeContext(f.m, f.s, request, AbortSignal.timeout(1_000));
    await applyContextCommands(f.m, f.s, f.generation, api, AbortSignal.timeout(1_000));
    const publish = async () => { publications++; ready.resolve(); await published.promise; };
    const completion = observeContextCompletion(f.m, f.s, f.generation, "completed-marker", publish);
    await ready.promise;
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("running");
    expect(readContextJournal(f.m, f.s).revision).toBe(0);
    expect(() => assertNoContextMutation(f.m, f.s)).toThrow();
    published.resolve(); await completion;
    expect(readContextOperation(f.m, f.s, request.operationId)?.state).toBe("completed");
    expect(readContextJournal(f.m, f.s).revision).toBe(1);
    await Promise.all([
      observeContextCompletion(f.m, f.s, f.generation, "completed-marker", publish),
      observeContextCompletion(f.m, f.s, f.generation, "completed-marker", publish),
    ]);
    expect(publications).toBe(1);
    expect(readContextJournal(f.m, f.s).revision).toBe(1);
  } finally { published.resolve(); f.cleanup(); }
});

test("context boundary flush drains the offered reset behind an in-flight content write", async () => {
  const f = await fixture(), producer = new ContentProducer(f.m, f.s, f.generation);
  try {
    producer.buffer.text("assistant", "turn-a", "item-a", "before compact", "replace", true); producer.publish();
    const cursor = { generation: f.generation, sequence: producer.buffer.snapshot().sequence };
    const prior = producer.writer.flush();
    producer.buffer.resetContext(); producer.publish();
    await producer.writer.flushPending(); await prior;
    expect(readContent(f.m, f.s, cursor)).toMatchObject({ reset: "context", baseline: [], records: [] });
  } finally { await producer.close(); f.cleanup(); }
});

test("history projects native IDs and reasoning summaries, never hidden reasoning or raw tool data", async () => {
  const f = await fixture(); const calls: string[] = [];
  const api = codexContextApi(f.m, f.s, { close() {}, async request(method) {
    calls.push(method); return { nextCursor: null, data: [
      { turnId: "turn-a", item: { id: "assistant-a", type: "agentMessage", text: "界".repeat(12_000) } },
      { turnId: "turn-a", item: { id: "reasoning-a", type: "reasoning", summary: ["brief summary"], content: ["HIDDEN_REASONING"] } },
      { turnId: "turn-a", item: { id: "tool-a", type: "commandExecution", command: "PRIVATE_COMMAND", aggregatedOutput: "PRIVATE_OUTPUT" } },
    ] };
  } });
  try {
    const page = await api.history({ limit: 8 }, AbortSignal.timeout(1_000));
    expect(page.entries[0]?.omittedBytes).toBeGreaterThan(0);
    expect(page.entries[0]?.text).not.toContain("�");
    expect(page.entries[1]?.text).toBe("brief summary");
    expect(JSON.stringify(page)).not.toMatch(/HIDDEN_REASONING|PRIVATE_COMMAND|PRIVATE_OUTPUT/);
    expect(calls).toEqual(["thread/items/list"]);
    const pending = readNativeHistory(f.m, f.s, { limit: 8 }, AbortSignal.timeout(1_000));
    await Bun.sleep(30);
    await applyContextCommands(f.m, f.s, f.generation, api, AbortSignal.timeout(1_000));
    expect((await pending).entries).toEqual(page.entries);
  } finally { f.cleanup(); }
});

test("fork ACK preserves destination identity; lost ACK never dispatches another fork", async () => {
  const f = await fixture(); let calls = 0, resumes = 0;
  const source = { target: managedPeer(f.m.rcPrefix, f.s), registration: f.s.registrationGeneration ?? f.s.uuid,
    generation: f.generation, nativeId: f.s.uuid, turnId: "turn-a" };
  const destination = makeSession({ agent: "codex", runtime: "app-server", registrationGeneration: crypto.randomUUID(), name: "fork-target" });
  try {
    await prepareNativeFork(f.m, destination.registrationGeneration ?? destination.uuid, source);
    const adapter = { fork: async () => { calls++; return { id: "destination-native" }; }, identity: (response: { id: string }) => response.id,
      resume: async (id: string) => { resumes++; return { id }; } };
    expect(await admitNativeFork(f.m, destination, adapter, AbortSignal.timeout(1_000))).toEqual({ id: "destination-native" });
    expect(await admitNativeFork(f.m, destination, adapter, AbortSignal.timeout(1_000))).toEqual({ id: "destination-native" });
    expect(calls).toBe(1); expect(resumes).toBe(1);
    const uncertain = { ...destination, registrationGeneration: crypto.randomUUID() };
    await prepareNativeFork(f.m, uncertain.registrationGeneration, source);
    const broken = { ...adapter, fork: async () => { calls++; throw new Error("private missing ACK"); } };
    await expect(admitNativeFork(f.m, uncertain, broken, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "FORK_UNCERTAIN" });
    await expect(admitNativeFork(f.m, uncertain, broken, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "FORK_UNCERTAIN" });
    expect(calls).toBe(2); expect(readNativeForkIntent(f.m, uncertain)?.state).toBe("uncertain");
  } finally { f.cleanup(); }
});

test("compact refuses already accepted native input before dispatch", async () => {
  const f = await fixture();
  try {
    await writeRuntimeInput(f.m, f.s, { messageId: crypto.randomUUID(), nativeId: "message-a", text: "pending", phase: "queued" });
    await expect(compactNativeContext(f.m, f.s, { operationId: crypto.randomUUID(), generation: f.generation }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "CONTEXT_BUSY" });
    expect(readContextJournal(f.m, f.s).operations).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("current Codex completion is the completed item, not start or retired thread notification", () => {
  const params = { threadId: "thread-a", turnId: "turn-a", item: { id: "compact-a", type: "contextCompaction" } };
  expect(isCodexContextCompletion({ method: "item/started", params }, "thread-a")).toBe(false);
  expect(isCodexContextCompletion({ method: "thread/compacted", params }, "thread-a")).toBe(false);
  expect(isCodexContextCompletion({ method: "item/completed", params }, "another-thread")).toBe(false);
  expect(isCodexContextCompletion({ method: "item/completed", params }, "thread-a")).toBe(true);
});

test("automatic compact invalidates history once and duplicate or retired completion cannot advance it", async () => {
  const f = await fixture();
  try {
    const cursor = encodeHistoryCursor(f.m, f.s, "native-before-auto");
    await observeContextCompletion(f.m, f.s, f.generation, "auto-compact-a");
    expect(readContextJournal(f.m, f.s).revision).toBe(1);
    await observeContextCompletion(f.m, f.s, f.generation, "auto-compact-a");
    await observeContextCompletion(f.m, f.s, crypto.randomUUID(), "retired-compact");
    expect(readContextJournal(f.m, f.s).revision).toBe(1);
    if (cursor !== null) expect(() => historyCursor(f.m, f.s, cursor)).toThrow();
    await observeContextCompletion(f.m, f.s, f.generation, "auto-compact-b");
    expect(readContextJournal(f.m, f.s).revision).toBe(2);
  } finally { f.cleanup(); }
});

test("OpenCode history forwards opaque native header cursor and omits unresolved native image bytes", async () => {
  const f = await fixture(); const urls: string[] = [];
  const s = { ...f.s, agent: "opencode", runtime: "native", nativeSession: { runtime: "opencode", id: "ses_context", version: "1.18.20" } };
  const session = makeSession(s);
  const client = createOpencodeClient({ baseUrl: "http://native.invalid", throwOnError: true,
    fetch: Object.assign(async (input: string | Request | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify([{ info: { id: "msg_visible", sessionID: "ses_context", role: "user", summary: { title: "user summary metadata" }, time: { created: 1 } },
        parts: [{ id: "part_image", type: "file", filename: "unresolved.png", url: "data:image/png;base64,PRIVATE_IMAGE" }] }]),
      { headers: { "content-type": "application/json", "X-Next-Cursor": "opaque-native-cursor" } });
    }, { preconnect: fetch.preconnect }),
  });
  try {
    const api = openCodeContextApi(f.m, session, client);
    const page = await api.history({ limit: 1 }, AbortSignal.timeout(1_000));
    expect(page.completeness).toBe("more");
    expect(page.entries[0]?.omittedImages).toBe(1);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_IMAGE");
    if (page.nextCursor === null) throw new Error("Expected native cursor");
    await api.history({ limit: 1, cursor: page.nextCursor }, AbortSignal.timeout(1_000));
    expect(new URL(urls[1] ?? "http://invalid").searchParams.get("before")).toBe("opaque-native-cursor");
  } finally { f.cleanup(); }
});

test("Codex history cancellation rejects before a delayed native reply without closing the shared writer", async () => {
  const f = await fixture(); let closed = 0, calls = 0;
  const response = { data: [], nextCursor: null };
  const rpc = { close() { closed++; }, async request() { calls++; await Bun.sleep(150); return response; } };
  try {
    const api = codexContextApi(f.m, f.s, rpc), started = performance.now();
    await expect(api.history({ limit: 1 }, AbortSignal.timeout(20))).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(120);
    expect(calls).toBe(1); expect(closed).toBe(0);
  } finally { f.cleanup(); }
});

test("cancelled Codex context RPC retains one slot until its late ACK and never accumulates native reads", async () => {
  const f = await fixture(), released = Promise.withResolvers<void>(); let calls = 0, closed = 0;
  const rpc = { close() { closed++; }, async request() {
    calls++; if (calls === 1) await released.promise; return { data: [], nextCursor: null };
  } };
  try {
    await expect(codexContextApi(f.m, f.s, rpc).history({ limit: 1 }, AbortSignal.abort())).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(codexContextApi(f.m, f.s, rpc).history({ limit: 1 }, AbortSignal.timeout(20))).rejects.toThrow();
    for (let attempt = 0; attempt < 20; attempt++) {
      await expect(codexContextApi(f.m, f.s, rpc).history({ limit: 1 }, AbortSignal.timeout(100)))
        .rejects.toMatchObject({ code: "CONTEXT_RPC_PENDING" });
    }
    await expect(codexContextApi(f.m, f.s, rpc).compactionMarker(AbortSignal.timeout(100)))
      .rejects.toMatchObject({ code: "CONTEXT_RPC_PENDING" });
    await expect(codexContextApi(f.m, f.s, rpc).compact(AbortSignal.timeout(100)))
      .rejects.toMatchObject({ code: "CONTEXT_RPC_PENDING" });
    expect(calls).toBe(1); expect(closed).toBe(0);
    released.resolve(); await Bun.sleep(0);
    expect((await codexContextApi(f.m, f.s, rpc).history({ limit: 1 }, AbortSignal.timeout(100))).entries).toEqual([]);
    expect(calls).toBe(2); expect(closed).toBe(0);
  } finally { released.resolve(); f.cleanup(); }
});

test("single background context pump leaves heartbeat and approval usable during a stalled history read", async () => {
  const f = await fixture(), released = Promise.withResolvers<void>();
  let historyCalls = 0, heartbeats = 0, approvals = 0, closed = 0;
  const errors: unknown[] = [];
  const rpc = { close() { closed++; }, async request(method: string) {
    if (method === "thread/items/list") { historyCalls++; await released.promise; }
    else if (method === "thread/read") heartbeats++;
    return { data: [], nextCursor: null };
  }, async respond() { approvals++; } };
  const pump = new NativeContextPump(error => errors.push(error));
  try {
    await writeHistoryMailbox(f.m, f.s, { id: crypto.randomUUID(), generation: f.generation, expiresAt: Date.now() + 5_000,
      query: { limit: 1 }, state: "queued", page: null, error: null });
    const run = (signal: AbortSignal) => applyContextCommands(f.m, f.s, f.generation, codexContextApi(f.m, f.s, rpc), signal);
    expect(pump.start(AbortSignal.timeout(5_000), run)).toBeUndefined();
    expect(historyCalls).toBe(1);
    const status = new OwnedCodexStatusWriter(f.m, f.s.name);
    for (let tick = 0; tick < 5; tick++) {
      pump.start(AbortSignal.timeout(5_000), run);
      await rpc.request("thread/read"); await status.write(f.projection.snapshot());
    }
    await rpc.respond();
    expect(heartbeats).toBe(5); expect(approvals).toBe(1); expect(historyCalls).toBe(1);
    expect(readHistoryMailbox(f.m, f.s)?.state).toBe("queued");
    const started = performance.now(); await pump.close();
    expect(performance.now() - started).toBeLessThan(100);
    expect(readHistoryMailbox(f.m, f.s)?.state).toBe("failed");
    released.resolve(); await Bun.sleep(0);
    expect(readHistoryMailbox(f.m, f.s)?.state).toBe("failed");
    expect(closed).toBe(0); expect(errors).toEqual([]);
  } finally { released.resolve(); await pump.close(); f.cleanup(); }
});

test("OpenCode owner pump keeps native status and permission RPC usable while history fetch is pending", async () => {
  const f = await fixture(), ready = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const session = makeSession({ ...f.s, agent: "opencode", runtime: "native",
    nativeSession: { runtime: "opencode", id: "ses_context", version: "1.18.20" } });
  let histories = 0, statuses = 0, approvals = 0;
  const errors: unknown[] = [], pump = new NativeContextPump(error => errors.push(error));
  const client = createOpencodeClient({ baseUrl: "http://native.invalid", throwOnError: true,
    fetch: Object.assign(async (input: string | Request | URL) => {
      const request = input instanceof Request ? input : new Request(String(input)), path = new URL(request.url).pathname;
      if (path.endsWith("/message")) {
        histories++; ready.resolve();
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(request.signal.reason);
          request.signal.addEventListener("abort", abort, { once: true });
          void released.promise.then(() => { request.signal.removeEventListener("abort", abort); resolve(Response.json([])); });
          if (request.signal.aborted) abort();
        });
      }
      if (path === "/session/status") statuses++;
      if (path === "/permission/permission-a/reply") approvals++;
      return Response.json(path === "/session/status" ? {} : true);
    }, { preconnect: fetch.preconnect }),
  });
  try {
    await writeHistoryMailbox(f.m, session, { id: crypto.randomUUID(), generation: f.generation, expiresAt: Date.now() + 5_000,
      query: { limit: 1 }, state: "queued", page: null, error: null });
    const run = (signal: AbortSignal) => applyContextCommands(f.m, session, f.generation, openCodeContextApi(f.m, session, client), signal);
    pump.start(AbortSignal.timeout(5_000), run); await ready.promise;
    for (let tick = 0; tick < 3; tick++) { pump.start(AbortSignal.timeout(5_000), run); await client.session.status(); }
    await client.permission.reply({ requestID: "permission-a", reply: "once" });
    expect(histories).toBe(1); expect(statuses).toBe(3); expect(approvals).toBe(1);
    expect(readHistoryMailbox(f.m, session)?.state).toBe("queued");
    const started = performance.now(); await pump.close();
    expect(performance.now() - started).toBeLessThan(100);
    expect(readHistoryMailbox(f.m, session)?.state).toBe("failed");
    released.resolve(); await Bun.sleep(0);
    expect(readHistoryMailbox(f.m, session)?.state).toBe("failed"); expect(errors).toEqual([]);
  } finally { released.resolve(); await pump.close(); f.cleanup(); }
});
