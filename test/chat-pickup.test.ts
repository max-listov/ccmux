import { expect, test } from "bun:test";
import { armTranscriptPickup, chatTurnProgressFromMessages } from "../src/chat/deliver.ts";
import { ChatCursorsSchema } from "../src/config/schema.ts";
import { unreadFor } from "../src/chat/store.ts";
import { makeChatMessage, makePeer } from "./helpers.ts";
import { managedPeerKey } from "../src/chat/identity.ts";
import type { TranscriptMessage } from "../src/types.ts";

const ID = "11111111-1111-4111-8111-111111111111";

function message(role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    createdAt: null,
    role,
    kind: "message",
    text,
    title: null,
    toolName: null,
    toolCallId: null,
    status: null,
    rawType: "response_item",
    done: false,
    result: null,
    input: null,
    resultText: null,
  };
}

function tool(): TranscriptMessage {
  return { ...message("assistant", ""), role: "tool", kind: "tool_call", text: null, toolName: "shell" };
}

test("pickup waits for the exact immutable chat id", () => {
  expect(chatTurnProgressFromMessages([message("assistant", "old answer")], ID)).toBe("awaiting-pickup");
  expect(chatTurnProgressFromMessages([message("user", `[chat from peer · id: ${ID}] hi`)], ID)).toBe("running");
});

test("intermediate assistant commentary before a tool is not a completed reply", () => {
  const turn = [
    message("user", `[chat from peer · id: ${ID}] hi`),
    message("assistant", "I will inspect it."),
    tool(),
  ];
  expect(chatTurnProgressFromMessages(turn, ID)).toBe("running");
  expect(chatTurnProgressFromMessages([...turn, message("assistant", "done")], ID)).toBe("answered");
});

test("crash after durable arm keeps one pickup barrier and hides the same ledger row from retry", () => {
  const recipient = makePeer({ machine: "host-a", session: "agent-b", threadId: "22222222-2222-4222-8222-222222222222", agent: "codex" });
  const msg = makeChatMessage({ id: ID, to: recipient });
  const cursors = ChatCursorsSchema.parse({});
  const key = managedPeerKey(recipient);
  armTranscriptPickup(cursors, key, { msg, idx: 0 }, "2026-08-26T00:00:00.000Z");

  // JSON round-trip models a daemon crash/restart between the atomic cursor write and Enter.
  const restarted = ChatCursorsSchema.parse(JSON.parse(JSON.stringify(cursors)));
  expect(restarted.pickups[key]?.messageId).toBe(ID);
  expect(restarted.delivered[key]).toBe(1);
  expect(unreadFor(recipient, [msg], restarted)).toEqual([]);
});
