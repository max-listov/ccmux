import { expect, test } from "bun:test";
import { ContentBuffer } from "../src/content/buffer.ts";
import { contentFrame } from "../src/content/read.ts";
import { CONTENT_FILE_MAX_BYTES, CONTENT_MAX_RECORDS, CONTENT_ITEM_BYTES, ContentSnapshotSchema } from "../src/content/schema.ts";
import { CODEX_CONTENT_METHODS, observeCodexContent } from "../src/content/codex.ts";
import { OpenCodeContentObserver } from "../src/content/opencode.ts";
import { makeMachine, makeSession } from "./helpers.ts";

function fixture() {
  const m = makeMachine({ rcPrefix: "host-a" });
  const s = makeSession({ agent: "codex", runtime: "app-server", registrationGeneration: crypto.randomUUID() });
  const generation = crypto.randomUUID();
  return { m, s, generation, buffer: new ContentBuffer(m, s, generation) };
}

test("content append offsets preserve UTF-8 and answers beyond the old tail", () => {
  const { buffer, generation } = fixture();
  buffer.text("assistant", "turn-a", "item-a", "", "replace");
  const cursor = { generation, sequence: buffer.snapshot().sequence };
  const expected = "A🙂漢字".repeat(1500);
  for (let i = 0; i < 1500; i++) buffer.text("assistant", "turn-a", "item-a", "A🙂漢字", "append");
  const live = contentFrame(buffer.snapshot(), cursor);
  expect(live.reset).toBe("gap");
  expect(live.baseline[0]?.text).toBe(expected);
  expect(live.baseline[0]?.totalBytes).toBe(Buffer.byteLength(expected));
  buffer.text("assistant", "turn-a", "item-a", expected, "replace", true);
  const final = buffer.snapshot().baseline[0];
  expect(final).toMatchObject({ complete: true, offsetBytes: 0, omittedBytes: 0, prefixKnown: true });
  expect(final?.text).toBe(expected);
  expect(Buffer.byteLength(JSON.stringify(ContentSnapshotSchema.parse(buffer.snapshot())))).toBeLessThan(CONTENT_FILE_MAX_BYTES);
});

test("split surrogate pairs and completed replacements never double-append", () => {
  const { buffer } = fixture();
  buffer.text("assistant", "t", "i", "", "replace");
  buffer.text("assistant", "t", "i", "\ud83d", "append");
  buffer.text("assistant", "t", "i", "\ude42", "append");
  expect(buffer.snapshot().baseline[0]).toMatchObject({ text: "🙂", totalBytes: 4 });
  buffer.text("assistant", "t", "i", "🙂", "replace", true);
  const sequence = buffer.snapshot().sequence;
  buffer.text("assistant", "t", "i", "🙂", "replace", true);
  buffer.text("assistant", "t", "i", "late", "append");
  buffer.text("assistant", "t", "i", "late stale started event", "replace");
  expect(buffer.snapshot().sequence).toBe(sequence);
  expect(buffer.snapshot().baseline[0]?.text).toBe("🙂");
});

test("large output is explicitly truncated while terminal and requests survive a burst", () => {
  const { buffer, generation } = fixture();
  buffer.lifecycle("request", null, "request-a", "requested");
  buffer.lifecycle("terminal", "prior", "terminal-a", "completed");
  for (let i = 0; i < 1000; i++) buffer.text("assistant", "active", "long", "x".repeat(1024), "append");
  const snapshot = ContentSnapshotSchema.parse(buffer.snapshot());
  expect(snapshot.records.length).toBeLessThanOrEqual(CONTENT_MAX_RECORDS);
  expect(snapshot.baseline.some(item => item.itemId === "request-a")).toBe(true);
  expect(snapshot.baseline.some(item => item.itemId === "terminal-a")).toBe(true);
  const long = snapshot.baseline.find(item => item.itemId === "long");
  expect(Buffer.byteLength(long?.text ?? "")).toBe(CONTENT_ITEM_BYTES);
  expect(long?.omittedBytes).toBe(1024 * 1000 - CONTENT_ITEM_BYTES);
  expect(long?.complete).toBe(false);
  expect(long?.prefixKnown).toBe(false);
  expect(contentFrame(snapshot, { generation, sequence: 0 }).reset).toBe("gap");
  expect(contentFrame(snapshot, { generation: crypto.randomUUID(), sequence: 0 }).reset).toBe("generation");
  expect(contentFrame(snapshot, { generation, sequence: snapshot.sequence }).records).toEqual([]);
  expect(contentFrame(snapshot, { generation, sequence: snapshot.sequence + 1 }).reset).toBe("gap");
  buffer.resetContext();
  expect(contentFrame(buffer.snapshot(), { generation, sequence: snapshot.sequence }).reset).toBe("context");
});

test("truncated completed text rejects late deltas and stale started events", () => {
  const { buffer } = fixture();
  const text = "🙂".repeat(20_000);
  buffer.text("assistant", "t", "large", text, "replace", true);
  const final = buffer.snapshot();
  expect(final.baseline[0]).toMatchObject({ complete: false, totalBytes: 80_000,
    omittedBytes: 80_000 - CONTENT_ITEM_BYTES });
  buffer.text("assistant", "t", "large", "LATE", "append");
  buffer.text("assistant", "t", "large", "stale started", "replace");
  expect(buffer.snapshot()).toEqual(final);
});

test("Codex allows assistant and explicit summary content but no private reasoning or tool output", () => {
  const { s, buffer } = fixture();
  const params = { threadId: s.uuid, turnId: "t", itemId: "i", delta: "PRIVATE_CANARY" };
  for (const method of ["item/reasoning/textDelta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta"])
    observeCodexContent(buffer, s.uuid, { method, params });
  observeCodexContent(buffer, s.uuid, { method: "item/completed", params: { threadId: s.uuid, turnId: "t",
    item: { type: "reasoning", id: "hidden", text: "PRIVATE_CANARY" } } });
  expect(buffer.snapshot().sequence).toBe(0);
  observeCodexContent(buffer, s.uuid, { method: "item/agentMessage/delta", params: { ...params, delta: "hello" } });
  observeCodexContent(buffer, s.uuid, { method: "item/reasoning/summaryTextDelta", params: { ...params, delta: "public summary", summaryIndex: 0 } });
  observeCodexContent(buffer, s.uuid, { method: "item/agentMessage/delta", params: { ...params, threadId: crypto.randomUUID() } });
  expect(JSON.stringify(buffer.snapshot())).not.toContain("PRIVATE_CANARY");
  expect(buffer.snapshot().baseline.map(item => item.kind)).toEqual(["assistant", "reasoning-summary"]);
});

test("OpenCode only streams known assistant text parts and correlated native completion", () => {
  const { buffer } = fixture();
  const observer = new OpenCodeContentObserver(buffer, "ses_a");
  observer.message({ id: "msg_a", sessionID: "ses_a", role: "assistant", parentID: "msg_user", time: { created: 1 } });
  observer.part({ id: "reasoning", messageID: "msg_a", sessionID: "ses_a", type: "reasoning", text: "PRIVATE_CANARY" });
  observer.event({ type: "message.part.delta", properties: { sessionID: "ses_a", messageID: "msg_a", partID: "reasoning", field: "text", delta: "PRIVATE_CANARY" } });
  observer.part({ id: "text", messageID: "msg_a", sessionID: "ses_a", type: "text", text: "" });
  observer.event({ type: "message.part.delta", properties: { sessionID: "ses_a", messageID: "msg_a", partID: "text", field: "text", delta: "hello" } });
  observer.message({ id: "msg_a", sessionID: "ses_a", role: "assistant", parentID: "msg_user", time: { created: 1, completed: 2 }, finish: "tool-calls" });
  expect(buffer.snapshot().baseline.some(item => item.kind === "terminal")).toBe(false);
  observer.message({ id: "msg_a", sessionID: "ses_a", role: "assistant", parentID: "msg_user", time: { created: 1, completed: 2 }, finish: "stop" });
  expect(buffer.snapshot().baseline.find(item => item.itemId === "text")?.text).toBe("hello");
  expect(buffer.snapshot().baseline.at(-1)).toMatchObject({ kind: "terminal", turnId: "msg_user", status: "completed" });
  expect(JSON.stringify(buffer.snapshot())).not.toContain("PRIVATE_CANARY");
});

test("Codex native Plan deltas reconcile to the authoritative completed plan", () => {
  const { s, buffer } = fixture();
  expect(CODEX_CONTENT_METHODS.has("item/plan/delta")).toBe(true);
  const params = { threadId: s.uuid, turnId: "plan-turn", itemId: "plan-item" };
  observeCodexContent(buffer, s.uuid, { method: "item/plan/delta", params: { ...params, delta: "Draft plan" } });
  expect(buffer.snapshot().baseline[0]?.text).toBe("Draft plan");
  const completed = { threadId: s.uuid, turnId: "plan-turn", item: { type: "plan", id: "plan-item", text: "Final plan" } };
  observeCodexContent(buffer, s.uuid, { method: "item/completed", params: completed });
  expect(buffer.snapshot().baseline[0]).toMatchObject({ kind: "assistant", text: "Final plan", complete: true });
  const sequence = buffer.snapshot().sequence;
  observeCodexContent(buffer, s.uuid, { method: "item/completed", params: completed });
  observeCodexContent(buffer, s.uuid, { method: "item/plan/delta", params: { ...params, delta: "late" } });
  expect(buffer.snapshot().sequence).toBe(sequence);
});
