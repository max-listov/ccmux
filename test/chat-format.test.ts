import { test, expect } from "bun:test";
import { formatChatInjection } from "../src/chat/format.ts";
import type { ChatMessage } from "../src/types.ts";

const base: ChatMessage = {
  id: "1",
  ts: "2026-07-24T10:00:00.000Z",
  from: "router",
  to: "worker",
  body: "do the thing",
  task: null,
  defer: false,
  onBehalfOf: null,
  notBefore: null,
};

test("plain peer message → [chat from <from>] body", () => {
  expect(formatChatInjection(base)).toBe("[chat from router] do the thing");
});

test("task is appended to the tag", () => {
  expect(formatChatInjection({ ...base, task: "deploy" })).toBe("[chat from router · task: deploy] do the thing");
});

test("onBehalfOf renders honest provenance without spoofing from", () => {
  // from stays the true (unspoofable) courier; the recipient still sees the real authority.
  expect(formatChatInjection({ ...base, onBehalfOf: "owner" })).toBe("[chat from router on behalf of owner] do the thing");
});

test("onBehalfOf + task combine in order", () => {
  expect(formatChatInjection({ ...base, onBehalfOf: "owner", task: "ship" })).toBe(
    "[chat from router on behalf of owner · task: ship] do the thing",
  );
});
