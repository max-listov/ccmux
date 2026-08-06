import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { retryCandidates, loadOutboxAcked, appendOutboxAck, RETRY_WINDOW_MS } from "../src/fleet/flush.ts";
import { appendOutbound } from "../src/fleet/outbox.ts";
import { localRows } from "../src/chat/fleetLog.ts";
import type { Outbound } from "../src/fleet/outbox.ts";
import { outboxAckPath, outboxPath } from "../src/config/paths.ts";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-flush-"));
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    stateDir: dir,
    bootLabel: "b",
  });
}

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const rec = (o: Partial<Outbound> = {}): Outbound => ({
  id: o.id ?? "id-1",
  ts: o.ts ?? new Date(NOW - 60_000).toISOString(),
  from: o.from ?? "agent-a",
  toMachine: o.toMachine ?? "host-b",
  toSession: o.toSession ?? "agent-b",
  kind: o.kind ?? "msg",
  body: o.body ?? "the answer",
  task: o.task ?? null,
  ok: o.ok ?? false,
  detail: o.detail ?? "transport failed",
});

test("a recent failed message is a retry candidate", () => {
  expect(retryCandidates([rec()], new Set(), NOW).map((r) => r.id)).toEqual(["id-1"]);
});

test("what must never be retried: successes, stale rows, already-settled ids", () => {
  const rows = [
    rec({ id: "ok", ok: true }),
    rec({ id: "stale", ts: new Date(NOW - RETRY_WINDOW_MS - 1000).toISOString() }),
    rec({ id: "settled" }),
    rec({ id: "live" }),
  ];
  expect(retryCandidates(rows, new Set(["settled"]), NOW).map((r) => r.id)).toEqual(["live"]);
});

test("a hand-off is an ACTION, not a letter — `restart --then` is never repeated", () => {
  // Repeating a message is safe once ids travel; repeating a kill-and-relaunch is a different
  // question entirely, and answering it silently would be reckless.
  expect(retryCandidates([rec({ id: "r", kind: "restart-then" })], new Set(), NOW)).toEqual([]);
});

test("the same id is offered once, however many attempts it has on record", () => {
  const rows = [rec({ id: "same" }), rec({ id: "same", ts: new Date(NOW - 30_000).toISOString() })];
  expect(retryCandidates(rows, new Set(), NOW)).toHaveLength(1);
});

test("acks round-trip and live beside the outbox, not inside it", () => {
  const m = tempConfig();
  expect(loadOutboxAcked(m).size).toBe(0);
  appendOutbound(m, rec());
  appendOutboxAck(m, "id-1");
  expect(loadOutboxAcked(m).has("id-1")).toBe(true);
  // The outbox stays an immutable record of ATTEMPTS; what finally landed is a separate file.
  expect(outboxAckPath(m)).not.toBe(outboxPath(m));
});

test("a message that arrived on retry stops being reported as lost", () => {
  const failed = rec({ id: "late" });
  const shouting = localRows("host-a", [], [failed]);
  expect(shouting[0]?.note).toContain("NOT SENT");
  const settled = localRows("host-a", [], [failed], new Set(["late"]));
  expect(settled[0]?.note).toBe("sent later, on retry");
});

test("an unparseable timestamp is skipped rather than retried forever", () => {
  expect(retryCandidates([rec({ ts: "not-a-date" })], new Set(), NOW)).toEqual([]);
});
