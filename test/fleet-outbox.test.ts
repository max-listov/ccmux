import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { appendOutbound, loadOutbox } from "../src/fleet/outbox.ts";
import { chatPaths } from "../src/chat/store.ts";
import type { Outbound } from "../src/fleet/outbox.ts";
import { outboxPath, sessionsPath } from "../src/config/paths.ts";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-outbox-"));
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    stateDir: dir,
    bootLabel: "b",
  });
}

const rec = (o: Partial<Outbound> = {}): Outbound => ({
  id: o.id ?? "id-1",
  ts: o.ts ?? "2026-08-05T10:00:00.000Z",
  from: o.from ?? "agent-a",
  toMachine: o.toMachine ?? "host-b",
  toSession: o.toSession ?? "agent-b",
  kind: o.kind ?? "msg",
  body: o.body ?? "hello",
  task: o.task ?? null,
  ok: o.ok ?? true,
  detail: o.detail ?? "",
});

test("outbound records round-trip, oldest first", () => {
  const m = tempConfig();
  expect(loadOutbox(m)).toEqual([]);
  appendOutbound(m, rec({ id: "a" }));
  appendOutbound(m, rec({ id: "b", kind: "restart-then" }));
  expect(loadOutbox(m).map((r) => r.id)).toEqual(["a", "b"]);
});

test("the outbox is a SEPARATE file from the chat ledger", () => {
  // Load-bearing: an outgoing row addressed to `agent-b` sitting in the shared ledger would be
  // matched by this machine's own delivery loop (which keys purely on `to`) and pasted into a
  // same-named LOCAL session — exactly the mis-delivery this whole feature removes.
  const m = tempConfig();
  appendOutbound(m, rec());
  expect(outboxPath(m)).not.toBe(chatPaths(m).ledger);
  expect(dirname(outboxPath(m))).toBe(dirname(sessionsPath(m)));
  expect(readFileSync(outboxPath(m), "utf8").trim().split("\n")).toHaveLength(1);
});

test("a failed hand-off is recorded, not dropped", () => {
  const m = tempConfig();
  appendOutbound(m, rec({ ok: false, detail: "transport failed" }));
  const [r] = loadOutbox(m);
  expect(r?.ok).toBe(false);
  expect(r?.detail).toBe("transport failed");
});

test("a corrupt line costs that line, not the whole history", () => {
  const m = tempConfig();
  appendOutbound(m, rec({ id: "good-1" }));
  writeFileSync(outboxPath(m), `${readFileSync(outboxPath(m), "utf8")}{not json\n`);
  appendOutbound(m, rec({ id: "good-2" }));
  expect(loadOutbox(m).map((r) => r.id)).toEqual(["good-1", "good-2"]);
});

test("bookkeeping never throws into the send it records", () => {
  // Unwritable location → the record is lost, but the caller (an ssh send that already happened)
  // must not fail because of its own log line.
  const m = MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    stateDir: "/proc/nonexistent-dir",
    bootLabel: "b",
  });
  expect(() => appendOutbound(m, rec())).not.toThrow();
});
