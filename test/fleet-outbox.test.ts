import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHAT_GENERATION, MachineConfigSchema } from "../src/config/schema.ts";
import { appendOutbound, loadOutbox, outboundId, outboundTimestamp } from "../src/fleet/outbox.ts";
import { chatPaths } from "../src/chat/store.ts";
import type { ChatMessage, ManagedPeer } from "../src/types.ts";
import type { Outbound } from "../src/fleet/outbox.ts";
import { outboxPath, sessionsPath } from "../src/config/paths.ts";
import { randomUUID } from "node:crypto";

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

const from: ManagedPeer = {
  kind: "managed",
  source: "ccmux",
  machine: "host-a",
  agent: "claude",
  session: "agent-a",
  threadId: "11111111-1111-4111-8111-111111111111",
};
const to: ManagedPeer = {
  kind: "managed",
  source: "ccmux",
  machine: "host-b",
  agent: "codex",
  session: "agent-b",
  threadId: "22222222-2222-4222-8222-222222222222",
};

function envelope(id: string = randomUUID()): ChatMessage {
  return {
    v: CHAT_GENERATION,
    id,
    ts: "2026-08-05T10:00:00.000Z",
    from,
    to,
    body: "hello",
    task: null,
    defer: false,
    onBehalfOf: null,
    notBefore: null,
  };
}

function rec(id: string = randomUUID()): Outbound {
  return { kind: "msg", envelope: envelope(id), result: { ok: true, detail: "" } };
}

test("outbound preserves the exact immutable message envelope", () => {
  const m = tempConfig();
  const record = rec();
  appendOutbound(m, record);
  expect(loadOutbox(m)).toEqual([record]);
  expect(outboundId(record)).toBe(record.envelope.id);
  expect(outboundTimestamp(record)).toBe(record.envelope.ts);
});

test("a retry record stays pinned after the target name is reused", () => {
  const m = tempConfig();
  appendOutbound(m, rec());
  const loaded = loadOutbox(m)[0];
  expect(loaded?.kind).toBe("msg");
  if (loaded?.kind !== "msg") throw new Error("expected msg record");
  expect(loaded.envelope.to).toEqual(to);
  expect(loaded.envelope.to).not.toEqual({ ...to, agent: "claude", threadId: "33333333-3333-4333-8333-333333333333" });
});

test("the v2 outbox remains separate from the v2 chat ledger", () => {
  const m = tempConfig();
  appendOutbound(m, rec());
  expect(outboxPath(m)).not.toBe(chatPaths(m).ledger);
  expect(dirname(outboxPath(m))).toBe(dirname(sessionsPath(m)));
  expect(readFileSync(outboxPath(m), "utf8").trim().split("\n")).toHaveLength(1);
});

test("a corrupt line costs that line, not the whole history", () => {
  const m = tempConfig();
  const first = randomUUID();
  const second = randomUUID();
  appendOutbound(m, rec(first));
  writeFileSync(outboxPath(m), `${readFileSync(outboxPath(m), "utf8")}{not json\n`);
  appendOutbound(m, rec(second));
  expect(loadOutbox(m).map(outboundId)).toEqual([first, second]);
});

test("bookkeeping never throws into the send it records", () => {
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

test("the unversioned v1 outbox is ignored", () => {
  const m = tempConfig();
  writeFileSync(join(m.stateDir, "outbox.jsonl"), `${JSON.stringify({ id: "old", toSession: "agent-b" })}\n`);
  expect(loadOutbox(m)).toEqual([]);
});
