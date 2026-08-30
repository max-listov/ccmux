import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeProjection } from "../src/agent/opencode/projection.ts";
import { OpenCodeContentObserver } from "../src/content/opencode.ts";
import { ContentBuffer } from "../src/content/buffer.ts";
import { openCodeContextApi } from "../src/context/opencode.ts";
import { makeMachine, makeSession } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const internal = "Called the Read tool with the following input: /private/owner-store/internal-image.png";
const authored = "Called the Read tool with the following input: /workspace/user-authored.png";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccmux-private-context-")); roots.push(root);
  const m = makeMachine({ stateDir: root, rcPrefix: "host-a" });
  const s = makeSession({ agent: "opencode", runtime: "native", registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: "opencode", id: "ses_private", version: "1.18.20" } });
  return { m, s };
}

test("native history omits synthetic and compaction text by metadata, not authored text patterns", async () => {
  const { m, s } = fixture();
  const summary = `Native context containing ${internal}`;
  const data = [
    { info: { id: "msg_user", sessionID: "ses_private", role: "user", summary: { title: "picker title" }, time: { created: 1 } },
      parts: [{ id: "authored", type: "text", text: authored },
        { id: "synthetic", type: "text", text: internal, synthetic: true }] },
    { info: { id: "msg_summary", parentID: "msg_user", sessionID: "ses_private", role: "assistant", summary: true,
      time: { created: 2, completed: 3 } }, parts: [{ id: "summary", type: "text", text: summary }] },
    { info: { id: "msg_reply", parentID: "msg_user", sessionID: "ses_private", role: "assistant", summary: false,
      time: { created: 4, completed: 5 } }, parts: [{ id: "reply", type: "text", text: "Visible reply" }] },
  ];
  const client = createOpencodeClient({ baseUrl: "http://native.invalid", throwOnError: true,
    fetch: Object.assign(async () => Response.json(data), { preconnect: fetch.preconnect }) });
  const page = await openCodeContextApi(m, s, client).history({ limit: 4 }, AbortSignal.timeout(1_000));
  expect(page.entries).toHaveLength(4);
  expect(page.entries[0]).toMatchObject({ kind: "user", text: authored, omittedBytes: 0 });
  expect(page.entries[1]).toMatchObject({ kind: "other", text: null, omittedBytes: Buffer.byteLength(internal) });
  expect(page.entries[2]).toMatchObject({ kind: "compaction", text: null, omittedBytes: Buffer.byteLength(summary) });
  expect(page.entries[3]).toMatchObject({ kind: "assistant", text: "Visible reply", omittedBytes: 0 });
  expect(page.omittedBytes).toBe(Buffer.byteLength(internal) + Buffer.byteLength(summary));
  expect(JSON.stringify(page)).not.toContain(internal);
});

function nativeEvents() {
  const message = (id: string, role: "user" | "assistant", summary?: boolean) => ({ type: "message.updated", properties: { info: {
    id, sessionID: "ses_private", role, ...(role === "assistant" ? { parentID: "msg_user" } : {}),
    ...(summary === undefined ? {} : { summary }), time: { created: 1 },
  } } });
  const part = (messageID: string, id: string, text: string, synthetic?: boolean) => ({ type: "message.part.updated", properties: { part: {
    id, sessionID: "ses_private", messageID, type: "text", text, ...(synthetic === undefined ? {} : { synthetic }),
  } } });
  const delta = (messageID: string, partID: string, text: string) => ({ type: "message.part.delta", properties: {
    sessionID: "ses_private", messageID, partID, field: "text", delta: text,
  } });
  return [message("msg_user", "user"), part("msg_user", "user_text", authored),
    part("msg_user", "private_user", internal, true), delta("msg_user", "private_user", internal),
    message("msg_summary", "assistant", true), part("msg_summary", "summary_text", internal),
    delta("msg_summary", "summary_text", internal), message("msg_reply", "assistant"),
    part("msg_reply", "private_reply", internal, true), delta("msg_reply", "private_reply", internal),
    part("msg_reply", "reply_text", authored), delta("msg_reply", "reply_text", " visible")];
}

test("native content and bounded projection exclude private context on snapshots and deltas", () => {
  const { m, s } = fixture();
  const buffer = new ContentBuffer(m, s, crypto.randomUUID());
  const observer = new OpenCodeContentObserver(buffer, "ses_private");
  const projection = new OpenCodeProjection(m, s, 123);
  for (const event of nativeEvents()) { observer.event(event); projection.event(event); }
  expect(buffer.snapshot().baseline.filter(item => item.kind === "assistant").map(item => item.text)).toEqual([`${authored} visible`]);
  expect(JSON.stringify(buffer.snapshot())).not.toContain(internal);
  expect(JSON.stringify(projection.snapshot())).not.toContain(internal);
  expect(projection.snapshot().nativeItems.some(item => item.kind === "user" && item.text === authored)).toBe(true);
  expect(projection.snapshot().nativeItems.some(item => item.kind === "assistant" && item.text === `${authored} visible`)).toBe(true);
});
