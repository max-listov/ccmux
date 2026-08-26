import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { CHAT_GENERATION, ChatMessageSchema } from "../src/config/schema.ts";
import { STALLED_HOLD_MS, holdReason } from "../src/chat/holdReason.ts";
import { makeSession } from "./helpers.ts";
import type { ChatMessage } from "../src/types.ts";

// An accepted-but-held message is indistinguishable, from the SENDER's side, from a peer that is
// simply quiet — and it stays that way for as long as the hold lasts. Measured on this fleet: a
// message held eleven hours behind a parked composer, three more sent on top of it, and a working
// session spent reporting "waiting for a reply" about a peer with nothing to reply to.

const letter = (): ChatMessage =>
  ChatMessageSchema.parse({
    v: CHAT_GENERATION,
    id: randomUUID(),
    ts: "2026-08-26T00:39:01.000Z",
    from: { kind: "cli", source: "ccmux", machine: "host-a" },
    to: { kind: "managed", source: "ccmux", machine: "host-b", agent: "claude", session: "agent-b", threadId: "11111111-1111-4111-8111-111111111111" },
    body: "text",
    task: null,
    defer: false,
    onBehalfOf: null,
    notBefore: null,
  });

const ctx = (msg: ChatMessage, heldForMs: number) => ({
  recipient: makeSession({ name: "agent-b" }),
  chatEnabled: true,
  running: true,
  nowMs: Date.parse("2026-08-26T12:00:00.000Z"),
  chatDeliverable: true,
  daemonHold: { reason: "that pane has unsent text in its composer — delivery waits rather than appending to it", msgId: msg.id, heldForMs },
});

test("a hold measured in seconds reads as the moment it is", () => {
  const msg = letter();
  const out = holdReason(msg, ctx(msg, 4_000));
  expect(out.kind).toBe("live");
  expect(out.text).not.toContain("held for");
});

test("a hold measured in hours SAYS so — that is the fact which changes what to do", () => {
  // The same sentence answered "wait a moment" and "this is not moving", and only one of them is
  // worth acting on. The duration is what separates them.
  const msg = letter();
  const out = holdReason(msg, ctx(msg, 11 * 3_600_000));
  expect(out.text).toContain("held for");
  expect(out.text).toContain("11h");
  // …and the reason itself survives, because the duration alone says nothing about the cause.
  expect(out.text).toContain("unsent text in its composer");
});

test("the threshold is minutes, not seconds — a person pauses between keystrokes", () => {
  const msg = letter();
  expect(holdReason(msg, ctx(msg, STALLED_HOLD_MS - 1)).text).not.toContain("held for");
  expect(holdReason(msg, ctx(msg, STALLED_HOLD_MS + 1)).text).toContain("held for");
});

test("a reason recorded about ANOTHER letter is not evidence about this one", () => {
  // Two messages queued for one recipient: the daemon holds on one, and the other must not inherit
  // its explanation.
  const msg = letter();
  const out = holdReason(msg, { ...ctx(msg, 11 * 3_600_000), daemonHold: { reason: "something else", msgId: randomUUID(), heldForMs: 11 * 3_600_000 } });
  expect(out.kind).toBe("pending");
  expect(out.text).not.toContain("something else");
});

test("the composer hold no longer claims someone is typing RIGHT NOW", () => {
  // True at three seconds and a lie at eleven hours — and the lie is the costly direction, because
  // it reads as transient and sends nobody to look.
  const msg = letter();
  const out = holdReason(msg, ctx(msg, 30_000));
  expect(out.text).not.toContain("right now");
  expect(out.text).toContain("waits rather than appending");
});
