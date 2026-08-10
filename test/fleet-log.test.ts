import { test, expect } from "bun:test";
import { localRows, mergeFleetLog, fmtRow, machineColumnWidth, LogPayloadSchema, type LogMachine, type LogRow } from "../src/chat/fleetLog.ts";
import type { ChatMessage } from "../src/types.ts";
import type { Outbound } from "../src/fleet/outbox.ts";
import { makeChatMessage, makePeer } from "./helpers.ts";
import { randomUUID } from "node:crypto";

const msg = (o: Partial<ChatMessage> & { ts: string }): ChatMessage =>
  makeChatMessage({ id: o.id ?? randomUUID(), body: "hi", ...o });

const out = (o: { ts: string; id?: string; body?: string; ok?: boolean; detail?: string }): Outbound => {
  const id = o.id ?? randomUUID();
  const from = makePeer({ session: "agent-a" });
  const to = makePeer({ machine: "host-b", agent: "codex", session: "agent-b" });
  const result = { ok: o.ok ?? true, detail: o.detail ?? "" };
  return { kind: "msg", envelope: makeChatMessage({ id, ts: o.ts, from, to, body: o.body ?? "do the thing" }), result };
};

const src = (machine: string, rows: LogRow[], ok = true): { machine: LogMachine; rows: LogRow[] } => ({
  machine: { machine, ok, error: ok ? null : "unreachable" },
  rows,
});

test("localRows merges ledger + outbox in time order", () => {
  const rows = localRows("host-a", [msg({ ts: "2026-08-05T10:00:02Z" })], [out({ ts: "2026-08-05T10:00:01Z" })]);
  expect(rows.map((r) => r.kind)).toEqual(["sent", "chat"]);
  expect(rows.every((r) => r.machine === "host-a")).toBe(true);
});

test("a remote sender is rendered with its machine, so a reply address is readable off the line", () => {
  const [row] = localRows("host-b", [msg({ ts: "t", from: makePeer({ machine: "host-a", session: "agent-a" }) })], []);
  expect(row?.from).toBe("ccmux/claude@host-a:agent-a#11111111-1111-4111-8111-111111111111");
});

test("a failed hand-off is visible as such, not silently absent", () => {
  const [row] = localRows("host-a", [], [out({ ts: "t", ok: false, detail: "transport failed" })]);
  expect(row?.note).toContain("NOT SENT");
  expect(fmtRow(row!)).toContain("transport failed");
});

test("mergeFleetLog interleaves machines by timestamp and keeps the newest N", () => {
  const a = src("host-a", localRows("host-a", [msg({ ts: "2026-08-05T10:00:00Z" }), msg({ ts: "2026-08-05T10:00:04Z" })], []));
  const b = src("host-b", localRows("host-b", [msg({ ts: "2026-08-05T10:00:02Z" })], []));
  expect(mergeFleetLog([a, b], 10).map((r) => r.machine)).toEqual(["host-a", "host-b", "host-a"]);
  expect(mergeFleetLog([a, b], 2).map((r) => r.ts)).toEqual(["2026-08-05T10:00:02Z", "2026-08-05T10:00:04Z"]);
});

test("equal timestamps keep source order — deterministic, not arbitrary", () => {
  const a = src("host-a", localRows("host-a", [msg({ ts: "t" })], []));
  const b = src("host-b", localRows("host-b", [msg({ ts: "t" })], []));
  expect(mergeFleetLog([a, b], 10).map((r) => r.machine)).toEqual(["host-a", "host-b"]);
  expect(mergeFleetLog([b, a], 10).map((r) => r.machine)).toEqual(["host-b", "host-a"]);
});

test("an unreachable machine contributes nothing but never breaks the merge", () => {
  const ok = src("host-a", localRows("host-a", [msg({ ts: "t" })], []));
  const dead = src("host-b", [], false);
  expect(mergeFleetLog([ok, dead], 10)).toHaveLength(1);
});

test("machine column appears only when there is more than one machine to tell apart", () => {
  expect(machineColumnWidth([{ machine: "host-a", ok: true, error: null }])).toBe(0);
  expect(
    machineColumnWidth([
      { machine: "host-a", ok: true, error: null },
      { machine: "host-bbbb", ok: true, error: null },
    ]),
  ).toBe("host-bbbb".length);
});

test("a peer's payload is parsed leniently — partial rows beat refusing to show anything", () => {
  const parsed = LogPayloadSchema.safeParse({
    machines: [{ machine: "host-b" }],
    rows: [{ machine: "host-b", ts: "t", kind: "chat", from: "a", to: "b", body: "x" }],
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data?.rows[0]?.task).toBeNull();
  expect(parsed.data?.machines[0]?.ok).toBe(true);
  // A shape we cannot read at all is rejected, so the caller can label the machine instead of lying.
  expect(LogPayloadSchema.safeParse({ machines: [], rows: [{ kind: "chat" }] }).success).toBe(false);
});
