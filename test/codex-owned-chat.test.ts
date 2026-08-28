import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChatCursorsSchema } from "../src/config/schema.ts";
import { deliverOwnedCodexPending, nativeDeliveryDependencies } from "../src/chat/ownedCodex.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { managedPeer, managedPeerKey } from "../src/chat/identity.ts";
import { makeMachine, makeSession, makeChatMessage } from "./helpers.ts";
import type { CodexAppRpc } from "../src/agent/codex/rpc.ts";
import type { OwnedCodexRead } from "../src/agent/codex/ownedSchema.ts";
import frames from "./fixtures/codex-pane/v0.147.0.json";

function fixture() {
  const m = makeMachine({ rcPrefix: "host-a" });
  const s = makeSession({ agent: "codex", runtime: "app-server" });
  const msg = makeChatMessage({ id: randomUUID(), to: managedPeer(m.rcPrefix, s) });
  const key = managedPeerKey(managedPeer(m.rcPrefix, s));
  const cursors = ChatCursorsSchema.parse({});
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: "idle" }, 0);
  let read: OwnedCodexRead = { protocol: 1, status: "live", reason: null, snapshot: projection.snapshot() };
  const calls: string[] = [];
  let pane = frames.idle;
  let nativeStatus: unknown = { type: "idle" };
  let canAcceptDirectInput = true;
  let failStart = false;
  let receipts: unknown[] = [];
  let hold = "";
  const rpc: CodexAppRpc = {
    close() { calls.push("close"); },
    async request(method, params) {
      calls.push(method);
      if (method === "thread/read") return { thread: { id: s.uuid, name: s.name, source: "appServer", status: nativeStatus, canAcceptDirectInput } };
      if (method === "turn/start") {
        expect(cursors.pickups[key]?.native).toEqual({ phase: "intent", turnId: null });
        expect(calls.at(-2)).toBe("save");
        expect(params).toMatchObject({ threadId: s.uuid, clientUserMessageId: msg.id });
        if (failStart) throw new Error("response lost after request was sent");
        return { turn: { id: "native-turn" } };
      }
      if (method === "thread/turns/list") return { data: receipts };
      throw new Error("unexpected RPC");
    },
  };
  const deps: typeof nativeDeliveryDependencies = {
    readStatus: () => read, connect: async () => { calls.push("connect"); return rpc; }, sessions: () => [s],
    typing: async () => false, gate: async (_m, _s, enabled) => { calls.push(enabled ? "ungate" : "gate"); return true; },
    capture: async () => { calls.push("capture"); return pane; },
    hold: async (_s, _id, reason) => { hold = reason; }, clearHold: () => { hold = ""; },
    save: async () => { calls.push("save"); }, ack: () => { calls.push("ack"); },
  };
  return { m, s, msg, key, cursors, calls, deps, projection,
    setRead(value: OwnedCodexRead) { read = value; }, setPane(value: string) { pane = value; },
    setNativeStatus(value: unknown) { nativeStatus = value; }, setPolicy(value: boolean) { canAcceptDirectInput = value; },
    loseResponse() { failStart = true; }, receipts(value: unknown[]) { receipts = value; }, hold: () => hold,
    run: (rateHeld = false) => deliverOwnedCodexPending(m, s, [msg], cursors, new Set(), rateHeld, Date.now(), deps),
  };
}

test("native delivery gates input, checks exact native identity and persists intent before one submission", async () => {
  const f = fixture();
  expect(await f.run()).toBe(1);
  expect(f.calls).toEqual(["connect", "gate", "capture", "thread/read", "save", "turn/start", "save", "ungate", "close"]);
  expect(f.cursors.pickups[f.key]?.native).toEqual({ phase: "accepted", turnId: "native-turn" });
  expect(f.cursors.delivered[f.key]).toBe(1);
});

test("native working/approval/input/unknown and unavailable snapshots never open a send connection", async () => {
  for (const state of ["working", "waiting-approval", "waiting-input", "unknown"] satisfies Array<NonNullable<OwnedCodexRead["snapshot"]>["state"]>) {
    const f = fixture();
    f.setRead({ protocol: 1, status: "live", reason: null, snapshot: { ...f.projection.snapshot(), state } });
    expect(await f.run()).toBe(0); expect(f.calls).toEqual([]); expect(f.hold()).toContain(state);
  }
  const f = fixture();
  f.setRead({ protocol: 1, status: "stale", reason: "expired", snapshot: null });
  expect(await f.run()).toBe(0); expect(f.calls).toEqual([]);
});

test("partial input, menus, unknown UI and queued input are held and input gating is always released", async () => {
  for (const pane of [frames.partial, frames.partialWithDimCompletion, frames.queued, frames.menu, frames.commandApproval, frames.unknown, frames.notDrawn]) {
    const f = fixture(); f.setPane(pane);
    expect(await f.run()).toBe(0);
    expect(f.calls).toEqual(["connect", "gate", "capture", "ungate", "close"]);
    expect(f.cursors.pickups[f.key]).toBeUndefined();
  }
});

test("native status owns work: an empty client's background spinner cannot override native idle", async () => {
  const f = fixture(); f.setPane(frames.working);
  expect(await f.run()).toBe(1);
});

test("native reread catches busy and input-policy changes after a stale idle observation", async () => {
  for (const status of [{ type: "active", activeFlags: [] }, { type: "active", activeFlags: ["waitingOnApproval"] }, { type: "notLoaded" }, { type: "systemError" }]) {
    const f = fixture(); f.setNativeStatus(status);
    expect(await f.run()).toBe(0); expect(f.calls).not.toContain("turn/start"); expect(f.calls).toContain("ungate");
  }
  const f = fixture(); f.setPolicy(false);
  expect(await f.run()).toBe(0); expect(f.calls).not.toContain("turn/start");
});

test("lost response persists indeterminate intent; retries never send or acknowledge again", async () => {
  const f = fixture(); f.loseResponse();
  await expect(f.run()).rejects.toThrow("response lost");
  expect(f.cursors.pickups[f.key]?.native?.phase).toBe("intent");
  expect(f.calls.slice(-2)).toEqual(["ungate", "close"]);
  expect(await f.run()).toBe(0);
  expect(f.calls.filter((call) => call === "turn/start")).toHaveLength(1);
  expect(f.calls).not.toContain("ack"); expect(f.hold()).toContain("indeterminate");
  f.receipts([{ id: "native-turn", status: "interrupted", items: [{ type: "userMessage", clientId: f.msg.id }] }]);
  expect(await f.run()).toBe(0);
  expect(f.cursors.pickups[f.key]).toBeUndefined();
  expect(f.calls.filter((call) => call === "turn/start")).toHaveLength(1);
});

test("conditional acknowledgement follows terminal native turn, not acceptance or idle before completion", async () => {
  const f = fixture(); f.msg.defer = true;
  await f.run();
  f.setRead({ protocol: 1, status: "live", reason: null, snapshot: { ...f.projection.snapshot(), turn: { id: "native-turn", status: "inProgress", startedAt: null } } });
  await f.run(); expect(f.calls).not.toContain("ack");
  f.setRead({ protocol: 1, status: "live", reason: null, snapshot: { ...f.projection.snapshot(), turn: { id: "native-turn", status: "interrupted", startedAt: null } } });
  await f.run(); expect(f.calls.filter((call) => call === "ack")).toHaveLength(1);
  expect(f.cursors.pickups[f.key]).toBeUndefined();
});

test("future delivery, rate holds and changed registration cannot submit", async () => {
  const future = fixture(); future.msg.notBefore = new Date(Date.now() + 60_000).toISOString();
  expect(await future.run()).toBe(0); expect(future.calls).toEqual([]);
  const rate = fixture(); expect(await rate.run(true)).toBe(0); expect(rate.calls).toEqual([]);
  const replaced = fixture(); replaced.deps.sessions = () => [{ ...replaced.s, uuid: randomUUID() }];
  expect(await replaced.run()).toBe(0); expect(replaced.calls).not.toContain("turn/start");
});
