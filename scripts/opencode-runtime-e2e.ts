#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { loadMachineConfig } from "../src/config/machine.ts";
import { atomicWrite } from "../src/util/atomic.ts";
import { createControlClient } from "../src/control/client.ts";
import { createCcmuxControlServiceClient, ControlServiceOperationSchema, CCMUX_CONTROL_SERVICE_PREFIX } from "../src/control/serviceDescriptor.ts";
import { controlSocket } from "../src/control/path.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { readManagedRuntimeStatus } from "../src/runtime/status.ts";
import { killSession } from "../src/tmux/tmux.ts";
import { verifyOpenCodeActions } from "./opencode-actions-e2e.ts";
import { verifyRuntimeCoexistence } from "./runtime-coexistence-e2e.ts";
import { verifyRuntimeConfidentiality } from "./runtime-confidentiality-e2e.ts";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function report(phase: string, evidence: unknown) { console.log(JSON.stringify({ phase, evidence })); }
async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) { check(Date.now() < deadline, `Deadline: ${label}`); await Bun.sleep(200); }
}

const root = process.argv[2];
if (root === undefined) {
  const probe = mkdtempSync(join(tmpdir(), "ccmux-opencode-e2e-"));
  const source = loadMachineConfig();
  const { telegram: _telegram, fleet: _fleet, launchRecipes: _recipes, ...machine } = source;
  const config = join(probe, "machine.json");
  mkdirSync(join(probe, "workspace"));
  await atomicWrite(join(probe, "workspace", "opencode.json"), JSON.stringify({ permission: { bash: "ask" } }), 0o600);
  await atomicWrite(config, JSON.stringify({ ...machine, rcPrefix: "probe", stateDir: join(probe, "state"),
    tmuxSocket: `ccmux-opencode-${crypto.randomUUID().slice(0, 8)}`, fleet: {}, launchRecipes: {},
    extraFlags: [], remoteControl: false, chatEnabled: true, eventsEnabled: false, externalInventory: false,
    ensureInterval: 3600, autoUpdate: false }), 0o600);
  const env: Record<string, string | undefined> = { ...process.env, CCMUX_CONFIG: config, CCMUX_STATE_DIR: join(probe, "state"),
    CCMUX_CACHE_DIR: join(probe, "cache"), CCMUX_DATA_DIR: join(probe, "data"),
    NATIVE_RUNTIME_PROBE_SECRET: `fixture-runtime-secret-${crypto.randomUUID()}` };
  delete env.CCMUX_SESSION; delete env.CCMUX_CHAT_CREDENTIAL;
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.filename, probe], {
    env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  report("isolated-probe", { root: probe });
  process.exit(await child.exited);
}
check(basename(root).startsWith("ccmux-opencode-e2e-"), "Not an isolated probe directory");
const m = loadMachineConfig();
check(m.stateDir === join(root, "state") && !m.telegram && !Object.keys(m.fleet ?? {}).length, "Not an isolated runtime");
const cli = process.env.CCMUX_E2E_CLI ?? join(process.cwd(), "src/cli.ts");
const spawnDaemon = () => Bun.spawn([process.execPath, "--no-env-file", cli, "daemon"],
  { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
let daemon = spawnDaemon();
const local = createControlClient({ socket: controlSocket(m) });
const service = createCcmuxControlServiceClient(async (url, init) => {
  const route = new URL(String(url));
  const operation = ControlServiceOperationSchema.parse(route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1));
  return fetch("http://ccmux.local/ccmux-control/v1/invoke", { unix: controlSocket(m), method: "POST",
    headers: { "content-type": "application/json" }, ...(init?.signal === undefined ? {} : { signal: init.signal }),
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), caller: "probe-client", service: "ccmux.control", revision: "1",
      operation, payload: typeof init?.body === "string" ? init.body : "{}" }) });
});
try {
  await until("prepared empty baseline", async () => { try { return (await local.list()).status === "live"; } catch { return false; } }, 15_000);
  check(loadSessions(m).length === 0, "Probe registry is not empty");
  const catalog = await service.runtimes({});
  check(catalog.runtimes.some(row => row.runtime === "opencode" && row.availability === "configured"), "OpenCode runtime is not discoverable");
  check(catalog.runtimes.some(row => row.runtime === "custom" && row.availability === "unavailable"), "Custom capability was fabricated");
  const create = { runtime: "opencode", requestId: crypto.randomUUID(), name: "native-agent", workspace: join(root, "workspace"),
    modelSelection: { provider: "openrouter", model: "z-ai/glm-5.3-flash" } } satisfies Parameters<typeof service.create>[0];
  const receipt = await service.create(create);
  const retry = await service.create(create);
  check(retry.duplicate && retry.target.threadId === receipt.target.threadId, "Create retry changed identity");
  const target = receipt.target;
  await until("native live baseline", async () => (await local.list()).sessions.some(row =>
    row.identity.threadId === target.threadId && row.availability === "live"), 20_000);
  const session = loadSessions(m).find(row => row.uuid === target.threadId);
  check(session, "Created identity is missing");
  const first = readManagedRuntimeStatus(m, session).snapshot;
  check(first?.nativeSession?.id === receipt.nativeSession?.id, "Continuation mismatch");
  report("created-through-public-service", { receipt, oneWriter: loadSessions(m).length === 1, generation: first?.generation });
  const messageId = crypto.randomUUID();
  const body = 'This is an isolated runtime acceptance test. Use the shell tool to run pwd, printf CCMUX_NATIVE_TOOL_OK, and append exactly one line with the text effect to effect.txt in this workspace. Also run: test -n "$NATIVE_RUNTIME_PROBE_SECRET" && printf CHECKED > env-check.txt . Do not print the variable value. Do not edit other files, contact other agents, or print environment variables. Reply NATIVE_DONE afterwards.';
  await service.message({ target, messageId, body });
  check((await service.message({ target, messageId, body })).duplicate, "Message retry was not idempotent");
  let approvals = 0;
  await until("first native tool turn", async () => {
    const frame = await service.native({ target });
    const pending = frame.pending[0];
    if (pending?.kind === "approval") {
      approvals++;
      await service.respond({ target, operationId: crypto.randomUUID(), generation: frame.generation,
        requestId: pending.requestId, kind: "approval", decision: "accept" });
    }
    const result = await service.wait({ target, timeoutMs: 1_000 });
    if (result.outcome === "failed") throw new Error("Native model turn failed");
    return result.outcome === "completed";
  });
  const frame = await service.native({ target });
  check(frame.items.some(item => item.kind === "tool" && item.stage === "completed"), "No real tool completion");
  check(frame.items.some(item => item.kind === "terminal" && item.status === "completed"), "No native terminal evidence");
  check((await service.get({ target })).model === create.modelSelection.model, "Selected native model was not preserved");
  check(approvals > 0, "No real native approval was observed");
  check(readFileSync(join(root, "workspace", "effect.txt"), "utf8").trim() === "effect", "Tool side effect duplicated");
  await verifyRuntimeConfidentiality(m, session, frame, root, cli);
  report("native-tool-turn", { kinds: [...new Set(frame.items.map(item => item.kind))], approvals, model: (await service.get({ target })).model });
  await verifyOpenCodeActions(service, target);
  const peer = await verifyRuntimeCoexistence(m, service, target, join(root, "workspace"));
  const baseline = await local.list();
  const before = [session, peer].map(row => readManagedRuntimeStatus(m, row).snapshot);
  check(before.every(row => row !== null), "Missing two-writer baseline");
  daemon.kill("SIGTERM"); await daemon.exited;
  const after = [session, peer].map(row => readManagedRuntimeStatus(m, row).snapshot);
  check(after.every((row, i) => row && row.providerPid === before[i]?.providerPid && row.threadId === before[i]?.threadId),
    "Daemon shutdown changed provider identity or PID");
  daemon = spawnDaemon();
  await until("replacement daemon", async () => {
    try { const fresh = await local.list(); return fresh.status === "live" && fresh.generation !== baseline.generation; } catch { return false; }
  }, 15_000);
  report("daemon-restart", { writersPreserved: true, providers: after.map(row => row?.provider) });
  await killSession(m, session.name);
  await service.start({ target });
  await until("same identity after restart", async () => {
    const row = await service.get({ target });
    const snapshot = readManagedRuntimeStatus(m, session).snapshot;
    return row.availability === "live" && snapshot !== null && snapshot.generation !== first?.generation;
  }, 20_000);
  check(loadSessions(m)[0]?.nativeSession?.id === receipt.nativeSession?.id, "Restart replaced native identity");
  check(readFileSync(join(root, "workspace", "effect.txt"), "utf8").trim() === "effect", "Restart replayed tool side effects");
  await service.message({ target, messageId: crypto.randomUUID(), body: "Reply RESUMED_OK only. Do not use tools." });
  await until("resumed native turn", async () => (await service.wait({ target, timeoutMs: 1_000 })).outcome === "completed");
  report("restart-resume", { managedId: target.threadId, nativeId: receipt.nativeSession?.id });
  await service.archive({ target });
  check(loadSessions(m)[0]?.archived, "Archive did not preserve the registration");
  report("completed", { publicService: true, duplicateCreate: true, duplicateMessage: true, toolTurn: true, restartResume: true, archive: true });
} finally {
  for (const session of loadSessions(m)) await killSession(m, session.name);
  daemon.kill("SIGTERM"); await daemon.exited;
  await local.close();
}
