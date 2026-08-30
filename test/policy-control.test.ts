import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { makeMachine, makeSession } from "./helpers.ts";
import { resolveApplicationPolicy, applicationPolicyEvidence } from "../src/policy/resolve.ts";
import { policySha256 } from "../src/policy/sources.ts";
import { nativePolicySkillsAcknowledged } from "../src/policy/codex.ts";
import { projectApplicationPolicy } from "../src/policy/projection.ts";
import { createControlSession } from "../src/control/lifecycle.ts";
import { ControlCreateReceiptSchema, ControlCreateSchema } from "../src/control/schema.ts";
import { loadSessions, writeSessionsUnlocked } from "../src/config/sessions.ts";
import type { CreateManagedInput } from "../src/commands/create.ts";
import { createManagedSession } from "../src/commands/create.ts";
import { ownedCodexArgv, ownedCodexThreadParams } from "../src/agent/codex/ownedLaunch.ts";
import { prepareManagedCodexTurn, startCodexAppTurn } from "../src/agent/codex/appServer.ts";
import type { CodexAppRpc } from "../src/agent/codex/rpc.ts";
import { codexTextInput } from "../src/agent/codex/turnInput.ts";
import { runOwnedCodexProcess } from "../src/agent/codex/ownedProcess.ts";
import { runOpenCodeProcess } from "../src/agent/opencode/process.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { OpenCodeProjection } from "../src/agent/opencode/projection.ts";
import { applyOpenCodeInput } from "../src/agent/opencode/input.ts";
import { prepareOpenCodeCatalog } from "../src/agent/opencode/catalog.ts";
import { admitOpenCode } from "../src/agent/opencode/admission.ts";
import { computeStamp, staleReasons } from "../src/agent/launchStamp.ts";
import { managedRuntimeRoot } from "../src/runtime/status.ts";
import { readRuntimeInput, writeRuntimeInput } from "../src/runtime/input.ts";
import { seedNativeSelection } from "../src/runtime/selection.ts";
import { log } from "../src/util/log.ts";

const roots: string[] = [];
const logged = spyOn(log, "error").mockImplementation(() => {});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); logged.mockClear(); });
afterAll(() => logged.mockRestore());

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-policy-control-")));
  roots.push(root);
  const dir = join(root, "workspace");
  const privateDir = join(root, "canonical");
  mkdirSync(dir, { mode: 0o700 }); mkdirSync(privateDir, { mode: 0o700 });
  const body = "Canonical private application fixture.";
  const source = { id: "instructions-a", path: join(privateDir, "instructions.md"), sha256: policySha256(body) };
  writeFileSync(source.path, body, { mode: 0o600 });
  const skillBody = "---\nname: skill-a\ndescription: Canonical skill fixture\n---\nCanonical private skill fixture.";
  const skill = { id: "skill-a", name: "skill-a", path: join(privateDir, "SKILL.md"), sha256: policySha256(skillBody) };
  writeFileSync(skill.path, skillBody, { mode: 0o600 });
  const m = makeMachine({ stateDir: join(root, "state"), rcPrefix: "host-a", codexBin: "/bin/codex", agentPolicies: {
    "policy-a": { runtime: "codex", revision: "r1", trustedRoots: [privateDir], instructionSources: [source], skills: [skill] },
    "agent-a": { runtime: "opencode", revision: "r1", trustedRoots: [privateDir], agent: { name: "agent-a", source }, denyTools: ["bash"] },
  } });
  const reference = { id: "policy-a", revision: "r1" };
  const policy = resolveApplicationPolicy(m, "codex", reference);
  const s = makeSession({ name: "agent-a", dir, agent: "codex", runtime: "app-server", chatEnabled: true,
    applicationPolicy: policy.metadata, modelSelection: { provider: "openai", model: "model-a" } });
  return { root, dir, body, skillBody, source, skill, m, s, policy, reference };
}

test("public create pins one immutable policy and same-ID retry cannot create a second writer", async () => {
  const f = fixture();
  let creates = 0;
  const create = async (_m: typeof f.m, input: CreateManagedInput) => {
    creates++;
    const session = makeSession({ name: input.name, dir: input.dir, agent: input.agent, runtime: input.runtime,
      registrationGeneration: input.registrationGeneration, applicationPolicy: input.applicationPolicy, flags: input.flags });
    await writeSessionsUnlocked(f.m, [session]);
    return session;
  };
  const input = { requestId: crypto.randomUUID(), name: "agent-a", workspace: f.dir, flags: [], applicationPolicy: f.reference };
  expect(ControlCreateSchema.parse(input).applicationPolicy).toEqual(f.reference);
  const [first, retry] = await Promise.all([
    createControlSession(f.m, input, new AbortController().signal, create),
    createControlSession(f.m, input, new AbortController().signal, create),
  ]);
  expect(creates).toBe(1);
  expect(first.target).toEqual(retry.target);
  expect(first.applicationPolicy?.policy).toEqual(f.policy.metadata);
  expect(first.applicationPolicy?.state).not.toBe("applied");
  expect(ControlCreateReceiptSchema.safeParse(first).success).toBe(true);
  expect(loadSessions(f.m)[0]?.applicationPolicy).toEqual(f.policy.metadata);
  expect(JSON.stringify(first)).not.toContain(f.source.path);
  expect(JSON.stringify(first)).not.toContain(f.body);
  const receiptPath = join(f.m.stateDir, "control", "create-requests.json");
  const accepted = readFileSync(receiptPath, "utf8");
  writeFileSync(f.source.path, "Changed source");
  await expect(createControlSession(f.m, input, new AbortController().signal, create)).rejects.toThrow("Application policy is unavailable");
  expect(creates).toBe(1);
  expect(readFileSync(receiptPath, "utf8")).toBe(accepted);
});

test("Codex applies private thread instructions plus native skills and preserves native Plan settings", async () => {
  const f = fixture();
  const calls: { method: string; params: unknown }[] = [];
  const rpc: CodexAppRpc = { close() {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === "skills/list") return { data: [{ cwd: f.dir, errors: [], skills: [{ name: f.skill.name, path: f.skill.path, enabled: true }] }] };
    if (method === "collaborationMode/list") return { data: [{ name: "Plan", mode: "plan", model: "native-default", reasoning_effort: "medium" }] };
    if (method === "turn/start") return { turn: { id: "turn-a" } };
    throw new Error("Unexpected native method");
  } };
  const policy = await prepareManagedCodexTurn(rpc, f.m, f.s, {
    thread: { id: f.s.uuid, name: null, source: null, status: { type: "idle" }, canAcceptDirectInput: true, turns: [] },
    model: "model-a", modelProvider: "openai",
  }, { runtime: "codex", model: { provider: "openai", model: "model-a" }, mode: "plan", effort: "high" });
  expect(policy?.collaborationMode?.settings).toEqual({ model: "model-a", reasoning_effort: "high", developer_instructions: null });
  expect(ownedCodexThreadParams(f.s, f.m).developerInstructions).toContain(f.body);
  expect(JSON.stringify(ownedCodexArgv(f.s, f.m))).not.toContain(f.body);
  expect(JSON.stringify(ownedCodexArgv(f.s, f.m))).not.toContain(f.skill.path);
  expect(await startCodexAppTurn(rpc, f.s.uuid, crypto.randomUUID(), codexTextInput("hello"), policy)).toBe("turn-a");
  const sent = z.object({ input: z.array(z.unknown()), collaborationMode: z.unknown() }).parse(calls.find(call => call.method === "turn/start")?.params);
  expect(sent.input).toContainEqual({ type: "skill", name: f.skill.name, path: f.skill.path });
  expect(JSON.stringify(sent.input)).not.toContain(f.body);
  expect(JSON.stringify(sent.input)).not.toContain(f.skillBody);
  expect(JSON.stringify(calls.find(call => call.method === "turn/start")?.params)).not.toContain("skillInputs");
  expect(calls[0]).toEqual({ method: "skills/list", params: { cwds: [f.dir], forceReload: true } });
  const count = calls.length;
  writeFileSync(f.source.path, "Changed source");
  await expect(prepareManagedCodexTurn(rpc, f.m, f.s, { thread: { id: f.s.uuid, name: null, source: null,
    status: { type: "idle" }, canAcceptDirectInput: true, turns: [] }, model: "model-a" })).rejects.toThrow("Application policy is unavailable");
  expect(calls).toHaveLength(count);
});

test("source failure prevents provider restart while status/stamp reads remain body-free", async () => {
  const f = fixture();
  const stamp = computeStamp(f.s, f.m, "ccmux");
  expect(stamp.applicationPolicy).toEqual(f.policy.metadata);
  expect(JSON.stringify(stamp)).not.toContain(f.body);
  writeFileSync(f.source.path, "Changed source");
  expect(computeStamp(f.s, f.m, "ccmux")).toEqual(stamp);
  expect(staleReasons({ ...stamp, ts: Date.now() }, { ...stamp, applicationPolicy: { ...f.policy.metadata, digest: "f".repeat(64) } })).toContain("policy");
  await expect(runOwnedCodexProcess(f.m, f.s)).rejects.toThrow("Application policy is unavailable");
});

test("policy applied evidence requires native identity and cannot survive stale/disconnected status", () => {
  const f = fixture();
  const projection = new OwnedCodexProjection(f.m, f.s, process.pid);
  expect(projection.snapshot().applicationPolicy?.state).toBe("desired");
  expect(nativePolicySkillsAcknowledged(f.policy, f.s.uuid, { threadId: f.s.uuid,
    item: { type: "userMessage", content: [{ type: "skill", name: f.skill.name, path: f.skill.path }] } })).toBe(true);
  expect(nativePolicySkillsAcknowledged(f.policy, f.s.uuid, { threadId: crypto.randomUUID(),
    item: { type: "userMessage", content: [{ type: "skill", name: f.skill.name, path: f.skill.path }] } })).toBe(false);
  expect(nativePolicySkillsAcknowledged(f.policy, f.s.uuid, { threadId: f.s.uuid,
    item: { type: "userMessage", content: [{ type: "text", text: "skill-a" }] } })).toBe(false);
  projection.policyEvidence(applicationPolicyEvidence(f.policy, "applied"));
  expect(projectApplicationPolicy(f.policy.metadata, "live", projection.snapshot().applicationPolicy).state).toBe("applied");
  expect(projectApplicationPolicy(f.policy.metadata, "stale", projection.snapshot().applicationPolicy).state).toBe("unavailable");
  projection.unavailable("disconnected");
  expect(projection.snapshot().applicationPolicy?.state).toBe("unavailable");
});

test("OpenCode native policy selection survives exact receipt reconciliation without another prompt", async () => {
  const f = fixture();
  const policy = resolveApplicationPolicy(f.m, "opencode", { id: "agent-a", revision: "r1" });
  const s = makeSession({ name: "agent-a", dir: f.dir, agent: "opencode", runtime: "native",
    registrationGeneration: crypto.randomUUID(),
    applicationPolicy: policy.metadata, nativeSession: { runtime: "opencode", id: "ses_native", version: "1.18.20" },
    modelSelection: { provider: "provider-a", model: "model-a" } });
  mkdirSync(managedRuntimeRoot(f.m, s), { recursive: true, mode: 0o700 });
  await seedNativeSelection(f.m, s, { runtime: "opencode", model: { provider: "provider-a", model: "model-a" } });
  const nativeId = "msg_native";
  await writeRuntimeInput(f.m, s, { messageId: crypto.randomUUID(), nativeId, text: "hello", phase: "queued" });
  let posts = 0;
  let sent: unknown;
  let receiptAgent = "agent-a";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/agent") return Response.json([{ name: "agent-a", mode: "primary", prompt: f.body,
      permission: [{ permission: "bash", pattern: "*", action: "deny" }] }]);
    if (path.endsWith("/prompt_async")) { posts++; sent = await request.json(); return new Response(null, { status: 204 }); }
    if (path.endsWith(`/message/${nativeId}`)) return Response.json({ info: {
      id: nativeId, sessionID: "ses_native", role: "user", agent: receiptAgent, time: { created: Date.now() },
    } });
    return new Response(null, { status: 404 });
  } });
  const client = createOpencodeClient({ baseUrl: server.url.href, throwOnError: true });
  try {
    const projection = new OpenCodeProjection(f.m, s, process.pid);
    projection.status({ type: "idle" });
    await applyOpenCodeInput(f.m, s, client, projection, new AbortController().signal);
    expect(posts).toBe(1);
    expect(z.object({ agent: z.string() }).parse(sent).agent).toBe("agent-a");
    expect(JSON.stringify(sent)).not.toContain(f.body);
    expect(readRuntimeInput(f.m, s)?.phase).toBe("accepted");
    expect(projection.snapshot().applicationPolicy?.state).toBe("applied");
    const restarted = new OpenCodeProjection(f.m, s, process.pid);
    restarted.status({ type: "idle" });
    await applyOpenCodeInput(f.m, s, client, restarted, new AbortController().signal);
    expect(posts).toBe(1);
    expect(restarted.snapshot().applicationPolicy?.state).toBe("applied");
    receiptAgent = "different-agent";
    const invalidReceipt = new OpenCodeProjection(f.m, s, process.pid);
    invalidReceipt.status({ type: "idle" });
    await expect(applyOpenCodeInput(f.m, s, client, invalidReceipt, new AbortController().signal))
      .rejects.toThrow("Application policy is unavailable");
    expect(readRuntimeInput(f.m, s)?.phase).toBe("accepted");
    expect(invalidReceipt.snapshot().applicationPolicy?.state).toBe("unavailable");
    writeFileSync(f.source.path, "Changed source");
    await expect(runOpenCodeProcess(f.m, s)).rejects.toThrow("Application policy is unavailable");
    expect(posts).toBe(1);
  } finally { await server.stop(true); }
});

test("non-native policy and mismatched OpenCode source refuse before reservation or native create", async () => {
  const f = fixture();
  await expect(createManagedSession(f.m, { name: "blocked", dir: f.dir, agent: "codex", flags: [], router: false,
    runtime: "tui", applicationPolicy: f.policy.metadata })).rejects.toThrow("Application policy is unavailable");
  expect(loadSessions(f.m)).toEqual([]);
  const policy = resolveApplicationPolicy(f.m, "opencode", { id: "agent-a", revision: "r1" });
  const s = makeSession({ name: "blocked", dir: f.dir, agent: "opencode", runtime: "native",
    registrationGeneration: crypto.randomUUID(), applicationPolicy: policy.metadata });
  let creates = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    if (new URL(request.url).pathname === "/agent") return Response.json([{ name: "agent-a", mode: "primary",
      prompt: "Mismatched source", permission: [{ permission: "bash", pattern: "*", action: "deny" }] }]);
    creates++; return new Response(null, { status: 500 });
  } });
  try {
    await expect(admitOpenCode(f.m, s, { client: createOpencodeClient({ baseUrl: server.url.href, throwOnError: true }),
      version: "1.18.20" }, true, new AbortController().signal)).rejects.toThrow("Application policy is unavailable");
    expect(creates).toBe(0);
    expect(existsSync(join(managedRuntimeRoot(f.m, s), "admission.json"))).toBe(false);
  } finally { await server.stop(true); }
});

test("native canonical agent catalog accepts null hidden while excluding explicitly hidden agents", async () => {
  const f = fixture();
  const s = makeSession({ name: "catalog-agent", dir: f.dir, agent: "opencode", runtime: "native",
    registrationGeneration: crypto.randomUUID(), nativeSession: { runtime: "opencode", id: "ses_catalog", version: "1.18.20" } });
  mkdirSync(managedRuntimeRoot(f.m, s), { recursive: true, mode: 0o700 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/agent") return Response.json([
      { name: "canonical", mode: "primary", hidden: null },
      { name: "visible", mode: "primary", hidden: false },
      { name: "omitted", mode: "primary" },
      { name: "private", mode: "primary", hidden: true },
      { name: "delegate", mode: "subagent", hidden: null },
    ]);
    if (new URL(request.url).pathname === "/config/providers") return Response.json({ providers: [], default: {} });
    return new Response(null, { status: 404 });
  } });
  try {
    await prepareOpenCodeCatalog(f.m, s, createOpencodeClient({ baseUrl: server.url.href, throwOnError: true }), new AbortController().signal);
    const result = z.object({ agents: z.array(z.string()) }).parse(JSON.parse(readFileSync(join(managedRuntimeRoot(f.m, s), "models.json"), "utf8")));
    expect(result.agents).toEqual(["canonical", "omitted", "visible"]);
  } finally { await server.stop(true); }
});
