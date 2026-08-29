import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeMachine, makeSession, UUID } from "./helpers.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { OwnedCodexStatusWriter, readOwnedCodexStatus, validateOwnedCodex } from "../src/agent/codex/ownedStatus.ts";
import { ownedCodexSocket, ownedCodexStatusPath } from "../src/agent/codex/ownedPaths.ts";
import { ownedCodexArgv, ownedCodexClientArgv, ownedCodexFlags } from "../src/agent/codex/ownedLaunch.ts";
import { codexRuntimeUpdates } from "../src/agent/codex/ownedCursor.ts";
import { CODEX_RUNTIME_MAX_BYTES, CODEX_RUNTIME_MAX_EVENTS, CODEX_RUNTIME_TTL_MS } from "../src/agent/codex/ownedSchema.ts";
import type { OwnedCodexRead } from "../src/agent/codex/ownedSchema.ts";

const session = makeSession({ agent: "codex", runtime: "app-server" });
const machine = makeMachine({ codexBin: "/bin/codex", rcPrefix: "host-a" });
const state = (projection: OwnedCodexProjection, status: unknown, now = Date.now()) =>
  projection.event({ method: "thread/status/changed", params: { threadId: UUID, status } }, now);
const turn = (projection: OwnedCodexProjection, method: "turn/started" | "turn/completed", status: string, id = "turn-1", now = Date.now()) =>
  projection.event({ method, params: { threadId: UUID, turn: { id, status } } }, now);

test("native state keeps provider flags and unknown distinct from connectivity", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  expect(p.snapshot()).toMatchObject({ connected: false, state: "unknown", reason: "starting" });
  for (const [native, expected] of [
    [{ type: "active", activeFlags: [] }, "working"],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "waiting-approval"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "waiting-input"],
    [{ type: "active", activeFlags: ["futureFlag"] }, "unknown"],
    [{ type: "notLoaded" }, "unknown"], [{ type: "systemError" }, "unknown"], [{ type: "idle" }, "idle"],
  ]) {
    state(p, native);
    expect(p.snapshot()).toMatchObject({ connected: true, state: expected });
  }
  p.unavailable("disconnected");
  expect(p.snapshot()).toMatchObject({ connected: false, state: "unknown" });
});

test("a newer event defeats a stale initial snapshot and foreign events cannot change state", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  const revision = p.revision;
  state(p, { type: "active", activeFlags: [] });
  expect(p.reconcile({ type: "idle" }, revision)).toBe(false);
  expect(p.snapshot().state).toBe("working");
  expect(p.event({ method: "thread/status/changed", params: { threadId: randomUUID(), status: { type: "idle" } } })).toBe(false);
  expect(p.event({ method: "turn/completed", params: {} })).toBe(false);
  expect(p.snapshot().state).toBe("working");
});

test("turn boundaries are identity pinned, deduplicated, and restore preserves observed start time", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  turn(p, "turn/started", "inProgress", "turn-1", 10_000);
  const sequence = p.snapshot().sequence;
  expect(turn(p, "turn/started", "inProgress")).toBe(false);
  expect(p.snapshot().sequence).toBe(sequence);
  p.restoreTurn({ id: "turn-1", status: "inProgress", startedAt: null });
  expect(p.snapshot().turn?.startedAt).toBe(new Date(10_000).toISOString());
  expect(turn(p, "turn/completed", "completed", "other")).toBe(false);
  turn(p, "turn/completed", "interrupted");
  expect(p.snapshot()).toMatchObject({ state: "idle", turn: { status: "interrupted" } });
  expect(turn(p, "turn/completed", "interrupted")).toBe(false);
  turn(p, "turn/started", "inProgress", "turn-2");
  turn(p, "turn/completed", "failed", "turn-2");
  expect(p.snapshot()).toMatchObject({ state: "unknown", reason: "turn-failed", turn: { status: "failed" } });
});

test("native requests distinguish transport submission from provider resolution", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  turn(p, "turn/started", "inProgress");
  expect(p.request({ id: "approval-a", method: "item/commandExecution/requestApproval", params: {
    threadId: session.uuid, turnId: "turn-1", itemId: "command-a", startedAtMs: Date.now(),
    reason: "confirm", availableDecisions: ["accept", "decline"],
  } })).toBe(true);
  expect(p.submitRequest("s:approval-a")).toBe(true);
  expect(p.snapshot().pendingRequests).toEqual([]);
  expect(p.snapshot().nativeItems.at(-1)).toMatchObject({ requestId: "s:approval-a", stage: "submitted" });
  expect(p.event({ method: "serverRequest/resolved", params: { threadId: session.uuid, requestId: "approval-a" } })).toBe(true);
  expect(p.snapshot().nativeItems.at(-1)).toMatchObject({ requestId: "s:approval-a", stage: "resolved" });
  expect(p.event({ method: "serverRequest/resolved", params: { threadId: session.uuid, requestId: "approval-a" } })).toBe(false);
});

test("resident events are bounded and readers detect cursor gaps and generation changes", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  state(p, { type: "idle" });
  const first = codexRuntimeUpdates({ protocol: 1, status: "live", reason: null, snapshot: p.snapshot() });
  expect(first.reset).toBe("initial");
  for (let i = 0; i < 200; i++) state(p, { type: i % 2 === 0 ? "systemError" : "idle" });
  const read: OwnedCodexRead & { snapshot: ReturnType<OwnedCodexProjection["snapshot"]> } = { protocol: 1, status: "live", reason: null, snapshot: p.snapshot() };
  expect(read.snapshot.events).toHaveLength(CODEX_RUNTIME_MAX_EVENTS);
  expect(Buffer.byteLength(JSON.stringify(read.snapshot))).toBeLessThan(CODEX_RUNTIME_MAX_BYTES);
  expect(codexRuntimeUpdates(read, first.cursor ?? undefined).reset).toBe("gap");
  expect(codexRuntimeUpdates(read, { generation: randomUUID(), sequence: 1 }).reset).toBe("generation");
  const delta = codexRuntimeUpdates(read, { generation: read.snapshot.generation, sequence: read.snapshot.sequence - 1 });
  expect(delta.events).toHaveLength(1);
  expect(delta.reset).toBeNull();
});

test("reader never exposes expired, dead, wrong identity or disconnected positive state", () => {
  const p = new OwnedCodexProjection(machine, session, process.pid);
  state(p, { type: "idle" }, 10_000);
  const identity = { machine: machine.rcPrefix, session: session.name, threadId: session.uuid };
  const bytes = JSON.stringify(p.snapshot());
  expect(validateOwnedCodex(bytes, identity, 10_001).status).toBe("live");
  expect(validateOwnedCodex(bytes, identity, 10_000 + CODEX_RUNTIME_TTL_MS)).toMatchObject({ status: "stale", snapshot: null });
  expect(validateOwnedCodex(bytes, { ...identity, threadId: randomUUID() }, 10_001).reason).toBe("identity-mismatch");
  expect(validateOwnedCodex(bytes, identity, 9_999).reason).toBe("clock-skew");
  expect(validateOwnedCodex(JSON.stringify({ ...p.snapshot(), providerPid: 2147483647 }), identity, 10_001).reason).toBe("producer-stopped");
  p.unavailable("lost", 10_001);
  expect(validateOwnedCodex(JSON.stringify(p.snapshot()), identity, 10_001)).toMatchObject({ status: "unavailable", snapshot: null });
});

test("prepared file reader rejects symlinks, permissive files and oversize; coalesced writes retain last state", async () => {
  const m = makeMachine({ stateDir: mkdtempSync("/tmp/ccmux-native-state-test-") });
  const p = new OwnedCodexProjection(m, session, process.pid);
  const writer = new OwnedCodexStatusWriter(m, session.name);
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 100; i++) { state(p, { type: i % 2 ? "idle" : "active", activeFlags: [] }); writes.push(writer.write(p.snapshot())); }
  await Promise.all(writes);
  expect(readOwnedCodexStatus(m, session).snapshot?.sequence).toBe(p.snapshot().sequence);
  const file = ownedCodexStatusPath(m, session.name);
  chmodSync(file, 0o666);
  expect(readOwnedCodexStatus(m, session).reason).toBe("unauthorized");
  chmodSync(file, 0o600);
  writeFileSync(file, " ".repeat(CODEX_RUNTIME_MAX_BYTES + 1));
  expect(readOwnedCodexStatus(m, session).reason).toBe("oversized");
  const linkMachine = makeMachine({ stateDir: join(m.stateDir, "other") });
  const link = ownedCodexStatusPath(linkMachine, session.name);
  mkdirSync(dirname(link), { recursive: true }); symlinkSync(file, link);
  expect(readOwnedCodexStatus(linkMachine, session).snapshot).toBeNull();
});

test("native launch keeps endpoint and UUID under owner control and disables only the client update prompt", () => {
  const argv = ownedCodexArgv(session, machine, "ccmux");
  expect(argv.slice(0, 4)).toEqual(["/bin/codex", "app-server", "--listen", `unix://${ownedCodexSocket(machine, session.name)}`]);
  expect(ownedCodexClientArgv(session, machine)).toContain(session.uuid);
  expect(ownedCodexClientArgv(session, machine)).toContain("check_for_update_on_startup=false");
  expect(() => ownedCodexFlags(["--remote", "unix:///tmp/other"])).toThrow();
  expect(() => ownedCodexFlags(["--resume", UUID])).toThrow();
  expect(() => ownedCodexFlags(["--model"])).toThrow();
  expect(ownedCodexFlags(["--sandbox", "read-only", "--no-alt-screen"])).toEqual({ server: ["-c", 'sandbox_mode="read-only"'], client: ["--no-alt-screen"] });
  expect(ownedCodexSocket(machine, session.name).length).toBeLessThan(100);
  expect(ownedCodexSocket(machine, session.name)).not.toBe(ownedCodexSocket({ stateDir: "/tmp/another-instance" }, session.name));
});

test("a rejected projection write cannot strand the next valid publication", async () => {
  const m = makeMachine({ stateDir: mkdtempSync("/tmp/ccmux-native-write-recovery-") });
  const p = new OwnedCodexProjection(m, session, process.pid); state(p, { type: "idle" });
  const writer = new OwnedCodexStatusWriter(m, session.name);
  await expect(writer.write({ ...p.snapshot(), version: "x".repeat(65) })).rejects.toThrow();
  await writer.write(p.snapshot());
  expect(readOwnedCodexStatus(m, session).snapshot?.state).toBe("idle");
});
