#!/usr/bin/env bun
import { CCMUX_CONTROL_SERVICE_INGRESS_PATH, CCMUX_CONTROL_SERVICE_REVISION } from "../src/control/serviceDescriptor.ts";
import { chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadMachineConfig } from "../src/config/machine.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { createCcmuxControlServiceClient, CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceOperationSchema } from "../src/control/serviceDescriptor.ts";
import { controlSocket } from "../src/control/path.ts";
import { newSession, killSession } from "../src/tmux/tmux.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";
import { connectOwnedCodex } from "../src/agent/codex/ownedRpc.ts";
import { prepareManagedCodexTurn, resumeCodexAppThreadContext, startCodexAppTurn } from "../src/agent/codex/appServer.ts";
import { codexTextInput } from "../src/agent/codex/turnInput.ts";
import type { ManagedPeer, Session } from "../src/types.ts";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const root = realpathSync(mkdtempSync("/tmp/ccmux-owned-probe-"));
const config = join(root, "machine.json");
const cli = resolve(process.argv[2] ?? "src/cli.ts");
const commandPrefix = cli.endsWith(".ts") || cli.endsWith(".js") ? [process.execPath, "--no-env-file", cli] : [cli];
// An extracted, checksum-verified published package can prove the installed client boundary too.
const publishedClient = process.argv[3];
const makeServiceClient: typeof createCcmuxControlServiceClient = publishedClient === undefined
  ? createCcmuxControlServiceClient
  : (await import(resolve(publishedClient))).createCcmuxControlServiceClient;
const machine = MachineConfigSchema.parse({ ...loadMachineConfig(), stateDir: join(root, "state"),
  rcPrefix: "probe", tmuxSocket: `ccmux-owned-${root.split("-").at(-1)}`, fleet: {}, wire: { peers: [] },
  autoUpdate: false, chatEnabled: true, sessionEvents: true, remoteControl: false, telegram: undefined,
  extraFlags: [], codexCorrelationTimeoutMs: 45_000, launchRecipes: { native: {
    revision: "1", flags: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
    environment: [], capabilities: ["input-requests"], collaborationMode: "plan",
  } },
});
const environment: Record<string, string> = { CCMUX_CONFIG: config, CCMUX_STATE_DIR: machine.stateDir,
  CCMUX_CACHE_DIR: join(root, "cache"), CCMUX_DATA_DIR: join(root, "data") };
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && environment[key] === undefined) environment[key] = value;
for (const key of ["CCMUX_SESSION", "CCMUX_CHAT_CREDENTIAL", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"])
  delete environment[key];
await Bun.write(config, JSON.stringify(machine));
chmodSync(config, 0o600);

async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await Bun.sleep(150); }
  throw new Error(`Timed out: ${label}`);
}
async function restartDaemon() {
  await killSession(machine, "probe-daemon");
  await newSession(machine, "probe-daemon", root, [...commandPrefix, "daemon"], environment);
  await until("control service", async () => {
    try { return (await fetch("http://ccmux.local/control/sessions", { unix: controlSocket(machine) })).ok; }
    catch { return false; }
  }, 15_000);
}
async function command(args: string[]) {
  const child = Bun.spawn([...commandPrefix, ...args], { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  check(code === 0, `Command failed (${code}): ${out} ${err}`);
}
const remote = makeServiceClient(async (url, init) => {
  const operation = ControlServiceOperationSchema.parse(new URL(String(url)).pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1));
  return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, { unix: controlSocket(machine), method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, id: crypto.randomUUID(),
      caller: machine.rcPrefix, service: "ccmux.control", revision: CCMUX_CONTROL_SERVICE_REVISION, operation,
      payload: typeof init?.body === "string" ? init.body : "{}" }) });
});
async function idle(target: ManagedPeer) {
  await until("native idle", async () => { try { return (await remote.get({ target })).state === "idle"; } catch { return false; } });
}
async function refused(run: () => Promise<unknown>, code: string) {
  try { await run(); } catch (error) { check(typeof error === "object" && error !== null && "code" in error && error.code === code, String(error)); return; }
  throw new Error(`Expected ${code}`);
}
async function toolTurn(target: ManagedPeer, session: Session, differentPreset?: string) {
  await idle(target);
  const marker = `READ_${crypto.randomUUID().replaceAll("-", "")}`;
  const before = await remote.native({ target, cursor: null });
  const body = `Use the native shell tool to run pwd in this workspace (read only), then reply exactly ${marker}. Do not edit files or contact any sessions.`;
  if (differentPreset !== undefined) {
    const rpc = await connectOwnedCodex(machine, session, { signal: AbortSignal.timeout(15_000) });
    try {
      const context = await resumeCodexAppThreadContext(rpc, target.threadId);
      const policy = await prepareManagedCodexTurn({ close() {}, request: async (method, params) => {
        const response = await rpc.request(method, params);
        if (method !== "collaborationMode/list") return response;
        const presets = z.object({ data: z.array(z.object({ mode: z.string().nullable() }).passthrough()) }).parse(response);
        return { data: presets.data.map((preset) => ({ ...preset, model: differentPreset })) };
      } }, machine, session, context);
      check(policy?.collaborationMode?.settings.model === session.modelSelection?.model, "Preset replaced model");
      await startCodexAppTurn(rpc, target.threadId, crypto.randomUUID(), codexTextInput(body), policy);
    } finally { rpc.close(); }
  } else await remote.message({ target, messageId: crypto.randomUUID(), body });
  await until("tool turn", async () => {
    const frame = await remote.native({ target, cursor: { generation: before.generation, sequence: before.sequence } });
    const records = [...frame.baseline, ...frame.records];
    return records.some((item) => item.kind === "assistant" && item.text?.includes(marker)) &&
      records.some((item) => item.kind === "tool" && item.text === "commandExecution" && item.status === "completed");
  });
  await idle(target);
  const rpc = await connectOwnedCodex(machine, session);
  try {
    const context = await resumeCodexAppThreadContext(rpc, target.threadId);
    check(context.model === session.modelSelection?.model && context.modelProvider === session.modelSelection?.provider,
      "Native execution changed selected provider/model");
  } finally { rpc.close(); }
}
const targets: ManagedPeer[] = [];
try {
  await restartDaemon();
  check(loadSessions(machine).length === 0, "Inventory not empty");
  const catalog = await remote.models({});
  const profiled = await remote.models({ launchRecipe: { id: "native", revision: "1" } });
  check(catalog.target === undefined && catalog.source.kind === "host" && catalog.source.provider === "openai", "Catalog source is wrong");
  check(profiled.data.length > 1 && loadSessions(machine).length === 0, "Catalog needs a conversation");
  const page = await remote.models({ limit: 1 });
  check(page.nextCursor !== null, "Pagination fixture too small");
  const next = await remote.models({ limit: 1, cursor: page.nextCursor });
  check(page.data[0]?.id !== next.data[0]?.id, "Pagination repeated a model");
  const directory = await remote.directories({ path: root });
  check(directory.path === root && directory.entries.some((entry) => entry.name === "machine.json"), "Directory service failed");
  const available = profiled.data.map((model) => model.model ?? model.id);
  const selected = [available.find((id) => id.endsWith("luna")), available.find((id) => id.endsWith("mini"))];
  const choices = [...new Set([...selected.filter((id): id is string => id !== undefined), ...available])].slice(0, 2);
  check(choices.length === 2, "Need two native models for acceptance");
  console.log(JSON.stringify({ phase: "empty-inventory-catalog", models: catalog.data.length, choices, directory: true }));
  const receipts = [];
  await refused(() => remote.create({ requestId: crypto.randomUUID(), name: "unavailable", workspace: root,
    flags: [], modelSelection: { provider: "openai", model: "fixture-model-not-in-catalog" } }), "MODEL_UNAVAILABLE");
  check(loadSessions(machine).length === 0, "Invalid selection created a registry row");
  for (const [index, model] of choices.entries()) {
    const input = { requestId: crypto.randomUUID(), name: `model-${index}`, workspace: root, flags: [],
      launchRecipe: { id: "native", revision: "1" }, modelSelection: { provider: "openai", model } };
    const created = await remote.create(input);
    targets.push(created.target);
    const retried = await remote.create(input);
    check(retried.duplicate && retried.target.threadId === created.target.threadId, "One-writer retry failed");
    await refused(() => remote.create({ ...input, modelSelection: { provider: "openai", model: "different" } }), "IDEMPOTENCY_CONFLICT");
    const session = loadSessions(machine).find((session) => session.uuid === created.target.threadId);
    check(session !== undefined, "Native registry missing");
    await toolTurn(created.target, session, index === 0 ? choices[1] : undefined);
    receipts.push({ input, created, session });
    console.log(JSON.stringify({ phase: "selected-model-tool-turn", model, differingPresetProbe: index === 0 }));
  }
  check(receipts[0]?.created.launchRecipe?.digest === receipts[1]?.created.launchRecipe?.digest, "Profiles differ");
  const first = receipts[0]!;
  await idle(first.created.target);
  const inputMarker = `INPUT_${crypto.randomUUID().replaceAll("-", "")}`;
  await remote.message({ target: first.created.target, messageId: crypto.randomUUID(),
    body: `Ask one native request_user_input question with two choices Red and Blue. Wait for the answer, then reply exactly ${inputMarker}. No other tools or messages.` });
  let inputFrame = await remote.native({ target: first.created.target, cursor: null });
  await until("Plan native input request", async () => {
    inputFrame = await remote.native({ target: first.created.target, cursor: null });
    return inputFrame.pending.some((request) => request.kind === "input");
  });
  const pending = inputFrame.pending.find((request) => request.kind === "input")!;
  const answers = Object.fromEntries(pending.questions.map((question) => [question.id, [question.options?.[0]?.label ?? "Red"]]));
  const answer = { target: first.created.target, operationId: crypto.randomUUID(), generation: inputFrame.generation,
    requestId: pending.requestId, kind: "input" as const, answers };
  await refused(() => remote.respond({ ...answer, generation: crypto.randomUUID() }), "STALE_REQUEST");
  check((await remote.respond(answer)).outcome === "submitted", "Exact input response failed");
  await until("input answer completed", async () => (await remote.native({ target: first.created.target, cursor: null })).baseline
    .some((item) => item.kind === "assistant" && item.text?.includes(inputMarker)));
  await idle(first.created.target);
  const before = readOwnedCodexStatus(machine, first.session).snapshot;
  check(before !== null, "Restart baseline missing");
  await command(["restart", first.session.name]);
  await until("new provider generation", () => {
    const snapshot = readOwnedCodexStatus(machine, first.session).snapshot;
    return snapshot !== null && snapshot.providerPid !== before.providerPid && snapshot.generation !== before.generation;
  });
  await restartDaemon();
  const retry = await remote.create(first.input);
  check(retry.duplicate && retry.target.threadId === first.created.target.threadId &&
    retry.modelSelection?.model === first.input.modelSelection.model, "Restart changed selection/identity");
  await toolTurn(retry.target, first.session);
  const model = (await remote.get({ target: retry.target })).nativeSelection?.model;
  check(model?.model === first.input.modelSelection.model, "Status lost model selection");
  const native = await remote.native({ target: retry.target, cursor: null });
  check(native.nativeSelection?.model.model === model.model, "Native projection lost selection");
  const waited = await remote.wait({ target: retry.target, timeoutMs: 10_000 });
  check(["idle", "completed"].includes(waited.outcome), "Wait did not see a terminal native boundary");
  const plain = await remote.create({ requestId: crypto.randomUUID(), name: "default-native", workspace: root,
    flags: ["-m", choices[0]!] });
  targets.push(plain.target);
  check(plain.launchRecipe === undefined && plain.modelSelection === undefined, "Default create synthesized selection");
  await idle(plain.target);
  for (const target of targets) check((await remote.archive({ target })).archived, "Archive failed");
  console.log(JSON.stringify({ ok: true, publishedClient: publishedClient !== undefined,
    models: choices, recipeCount: 1, emptyInventoryCatalog: true,
    directory: true, nativeToolTurns: 3, differingPreset: "injected into real native capability response; real turn retained selection",
    retryOneWriter: true, changedSelectionRefused: true, unavailableBeforeWriter: true, exactPlanInput: true,
    wait: waited.outcome, defaultCreate: true, providerAndDaemonRestart: true, archived: targets.length,
    identityHash: createHash("sha256").update(first.created.target.threadId).digest("hex").slice(0, 16) }));
} finally {
  for (const target of targets) await remote.archive({ target }).catch(() => {});
  await killSession(machine, "probe-daemon");
  console.log(JSON.stringify({ evidenceDirectory: root }));
}
