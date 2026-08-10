import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_GENERATION, MachineConfigSchema } from "../src/config/schema.ts";
import {
  appendMessage,
  loadLedger,
  loadCursors,
  unreadFor,
  markRead,
  chatPaths,
  fmtMessage,
  nextForRecipient,
  pendingConditional,
} from "../src/chat/store.ts";
import { chatPrincipalKey, managedPeerKey } from "../src/chat/identity.ts";
import type { AgentKind, ChatMessage, ChatPrincipal, ChatTarget, ManagedPeer } from "../src/types.ts";
import { randomUUID } from "node:crypto";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-chat-"));
  return MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    stateDir: dir,
    bootLabel: "b",
  });
}

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const THREAD_C = "33333333-3333-4333-8333-333333333333";

function peer(session: string, threadId: string, agent: AgentKind = "claude", machine = "host-a"): ManagedPeer {
  return { kind: "managed", source: "ccmux", machine, agent, session, threadId };
}

function msg(from: ChatPrincipal, to: ChatTarget, body: string, task: string | null = null): ChatMessage {
  return {
    v: CHAT_GENERATION,
  id: randomUUID(),
    ts: "2026-07-19T10:00:00.000Z",
    from,
    to,
    body,
    task,
    defer: false,
    onBehalfOf: null,
    notBefore: null,
  };
}

test("append + loadLedger round-trips a full immutable envelope", () => {
  const m = tempConfig();
  const a = peer("agent-a", THREAD_A);
  const b = peer("agent-b", THREAD_B, "codex");
  appendMessage(m, msg(a, b, "one"));
  expect(loadLedger(m)[0]).toEqual(expect.objectContaining({ from: a, to: b, body: "one" }));
});

test("unread cursors key the exact managed peer, not its reusable session name", async () => {
  const m = tempConfig();
  const sender = peer("sender", THREAD_A);
  const oldTarget = peer("worker", THREAD_B, "claude");
  const reusedTarget = peer("worker", THREAD_C, "codex");
  appendMessage(m, msg(sender, oldTarget, "old thread only"));

  const ledger = loadLedger(m);
  expect(unreadFor(oldTarget, ledger, loadCursors(m))).toHaveLength(1);
  expect(unreadFor(reusedTarget, ledger, loadCursors(m))).toEqual([]);
  await markRead(m, oldTarget, ledger.length);
  expect(loadCursors(m).read[managedPeerKey(oldTarget)]).toBe(1);
  expect(loadCursors(m).read[managedPeerKey(reusedTarget)]).toBeUndefined();
});

test("nextForRecipient requires the full pinned target tuple", () => {
  const sender = peer("sender", THREAD_A);
  const oldTarget = peer("worker", THREAD_B, "claude");
  const reusedTarget = peer("worker", THREAD_C, "codex");
  const ledger = [msg(sender, oldTarget, "old")];
  expect(nextForRecipient(oldTarget, ledger, 0)?.idx).toBe(0);
  expect(nextForRecipient(reusedTarget, ledger, 0)).toBeNull();
});

test("conditional dedup filters by exact principal and target identity", () => {
  const sender = peer("sender", THREAD_A);
  const otherSender = peer("sender", THREAD_C, "codex");
  const target = peer("worker", THREAD_B);
  const conditional = { ...msg(sender, target, "watch", "job"), notBefore: "2026-08-11T00:00:00.000Z" };
  expect(pendingConditional([conditional], new Set(), { from: sender, to: target, task: "job" })).toEqual([conditional]);
  expect(pendingConditional([conditional], new Set(), { from: otherSender, to: target, task: "job" })).toEqual([]);
});

test("fmtMessage exposes source, provider, machine, session and thread", () => {
  const rendered = fmtMessage(msg(peer("agent-a", THREAD_A, "claude"), peer("agent-b", THREAD_B, "codex", "host-b"), "hello"));
  expect(rendered).toContain(`ccmux/claude@host-a:agent-a#${THREAD_A}`);
  expect(rendered).toContain(`ccmux/codex@host-b:agent-b#${THREAD_B}`);
});

test("stable keys distinguish provider, thread and cli principal", () => {
  const claude = peer("worker", THREAD_A, "claude");
  const codex = peer("worker", THREAD_A, "codex");
  expect(managedPeerKey(claude)).not.toBe(managedPeerKey(codex));
  expect(chatPrincipalKey({ kind: "cli", source: "ccmux", machine: "host-a" })).toBe("ccmux:host-a:cli");
});

test("a record from an older generation fails LOUD, and says which generation it is", () => {
  // The cutover is deliberate: records written before the identity model carry no provider or thread,
  // and guessing those in would misroute mail. What must not happen is a SILENT skip — that turns a
  // stale file into invisible data loss. The generation lives in the record, so the refusal can name
  // the cause instead of complaining about a field shape, and point at where such records belong.
  const m = tempConfig();
  writeFileSync(chatPaths(m).ledger, `${JSON.stringify({ id: "old", from: "a", to: "b" })}\n`);
  expect(() => loadLedger(m)).toThrow(/generation none, this build reads 2/);
  expect(() => loadLedger(m)).toThrow(/archive/);
});

test("a record claiming a FUTURE generation is refused just as loudly", () => {
  // Both directions matter: an older ccmux meeting a newer record must stop, not reinterpret it.
  const m = tempConfig();
  writeFileSync(chatPaths(m).ledger, `${JSON.stringify({ v: 99, id: "x", ts: "now", from: "a", to: "b", body: "y" })}\n`);
  expect(() => loadLedger(m)).toThrow(/generation 99, this build reads 2/);
});

test("a name-only row that DOES claim the current generation still fails closed", () => {
  // The generation check is a better error, not a replacement for strict validation.
  const m = tempConfig();
  writeFileSync(chatPaths(m).ledger, `${JSON.stringify({ v: 2, id: "old", ts: "now", from: "a", to: "b", body: "x" })}\n`);
  expect(() => loadLedger(m)).toThrow();
});
