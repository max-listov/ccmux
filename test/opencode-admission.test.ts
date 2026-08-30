import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { makeMachine, makeSession } from "./helpers.ts";
import { admitOpenCode } from "../src/agent/opencode/admission.ts";
import { applyOpenCodeInput } from "../src/agent/opencode/input.ts";
import { OpenCodeProjection } from "../src/agent/opencode/projection.ts";
import { managedRuntimeRoot, ManagedRuntimeStatusWriter } from "../src/runtime/status.ts";
import { readRuntimeInput, writeRuntimeInput } from "../src/runtime/input.ts";

function fixture() {
  const root = mkdtempSync("/tmp/ccmux-native-admission-");
  const m = makeMachine({ stateDir: join(root, "state") });
  const s = makeSession({ name: "native", dir: root, agent: "opencode", runtime: "native", registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: "opencode", id: "ses_native", version: "1.18.20" } });
  new ManagedRuntimeStatusWriter(m, s);
  return { m, s };
}

test("lost native create response reconciles the reservation without a second POST", async () => {
  const { m, s } = fixture();
  const { nativeSession: _continuation, ...initial } = s;
  let posts = 0;
  const native = { id: "ses_native", directory: s.dir, version: "1.18.20", model: { id: "model-a", providerID: "provider-a" },
    metadata: { ccmuxRegistration: s.registrationGeneration } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST") { posts++; return new Response("lost after commit", { status: 502 }); }
    return Response.json(new URL(request.url).pathname === "/session" ? [native] : native);
  } });
  const client = createOpencodeClient({ baseUrl: server.url.href, throwOnError: true });
  try {
    await expect(admitOpenCode(m, initial, { client, version: "1.18.20" }, true, new AbortController().signal)).rejects.toBeDefined();
    const resumed = await admitOpenCode(m, initial, { client, version: "1.18.20" }, true, new AbortController().signal);
    expect(posts).toBe(1); expect(resumed.uuid).toBe(initial.uuid); expect(resumed.nativeSession?.id).toBe(native.id);
  } finally { await server.stop(true); }
});

test("missing or corrupt admission evidence refuses instead of spawning a replacement conversation", async () => {
  const { m, s } = fixture();
  const { nativeSession: _continuation, ...initial } = s;
  let posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST") posts++;
    return Response.json([]);
  } });
  const client = createOpencodeClient({ baseUrl: server.url.href, throwOnError: true });
  const path = join(managedRuntimeRoot(m, s), "admission.json");
  try {
    writeFileSync(path, JSON.stringify({ generation: s.registrationGeneration, nativeId: null }), { mode: 0o600 });
    await expect(admitOpenCode(m, initial, { client, version: "1.18.20" }, true, new AbortController().signal)).rejects.toThrow("unambiguously");
    writeFileSync(path, "{invalid", { mode: 0o600 });
    await expect(admitOpenCode(m, initial, { client, version: "1.18.20" }, true, new AbortController().signal)).rejects.toThrow("invalid");
    expect(posts).toBe(0);
  } finally { await server.stop(true); }
});

test("lost prompt ACK is proven by the exact native user record and never reposted", async () => {
  const { m, s } = fixture();
  const input = { messageId: crypto.randomUUID(), nativeId: "msg_input", text: "safe prompt", phase: "queued",
    turnOptions: { revision: 0, options: { runtime: "opencode", model: { provider: "provider-a", model: "model-a" } } } } satisfies Parameters<typeof writeRuntimeInput>[2];
  await writeRuntimeInput(m, s, input);
  const projection = new OpenCodeProjection(m, s, process.pid); projection.status({ type: "idle" });
  let posts = 0;
  let reads = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "POST") { posts++; return new Response("lost after native admission", { status: 502 }); }
    if (++reads === 1) return new Response("record not visible yet", { status: 404 });
    return Response.json({ info: { id: input.nativeId, sessionID: "ses_native", role: "user", time: { created: Date.now() } } });
  } });
  const client = createOpencodeClient({ baseUrl: server.url.href, throwOnError: true });
  try {
    await expect(applyOpenCodeInput(m, s, client, projection, new AbortController().signal)).rejects.toBeDefined();
    expect(readRuntimeInput(m, s)?.phase).toBe("dispatching");
    await applyOpenCodeInput(m, s, client, projection, new AbortController().signal);
    expect(readRuntimeInput(m, s)?.phase).toBe("uncertain");
    await applyOpenCodeInput(m, s, client, projection, new AbortController().signal);
    expect(readRuntimeInput(m, s)?.phase).toBe("accepted");
    await applyOpenCodeInput(m, s, client, projection, new AbortController().signal);
    expect(posts).toBe(1);
  } finally { await server.stop(true); }
});
