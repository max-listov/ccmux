import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNDJSON } from "stitchkit";
import { loadSessions, writeSessionsUnlocked } from "../src/config/sessions.ts";
import { managedPeer, managedPeerKey } from "../src/chat/identity.ts";
import { loadLedger } from "../src/chat/store.ts";
import { MonitoringPublisher } from "../src/monitoring/publish.ts";
import { UNSEEN } from "../src/events/observe.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { OwnedCodexStatusWriter } from "../src/agent/codex/ownedStatus.ts";
import { ControlPublisher } from "../src/control/publisher.ts";
import { createControlServer } from "../src/control/server.ts";
import { createControlClient } from "../src/control/client.ts";
import { controlSocket } from "../src/control/path.ts";
import {
  CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceDescriptorSchema,
  ControlServiceOperationSchema,
  ccmuxControlServiceDescriptor,
  createCcmuxControlServiceClient,
} from "../src/control/serviceDescriptor.ts";
import {
  ControlNativeStreamFrameSchema,
  encodeControlNativeStreamCursor,
  readControlNativeStreamCursor,
} from "../src/control/nativeStreamContract.ts";
import { makeMachine, makeSession } from "./helpers.ts";
import { ExternalStatusPublisher } from "../src/external/resident-publisher.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { launchRecipe?: boolean } = {}) {
  const root = mkdtempSync("/tmp/ccmux-service-test-");
  const recipeEnvFile = join(root, "provider.env");
  const recipeSecret = "fixture-service-secret-never-public";
  if (options.launchRecipe) writeFileSync(recipeEnvFile, `MODEL_SERVICE_TOKEN=${recipeSecret}\n`);
  const machine = makeMachine({
    stateDir: root,
    rcPrefix: "host-a",
    projectsDir: join(root, "history"),
    chatEnabled: true,
    codexHome: join(root, "codex"),
    codexSessionsDir: join(root, "codex", "sessions"),
    ...(options.launchRecipe ? { launchRecipes: { "provider-a": {
      revision: "r1", envFile: recipeEnvFile,
      flags: ["-c", 'model_provider="provider-a"',
        "-c", 'model_providers.provider-a.name="Provider A"',
        "-c", 'model_providers.provider-a.base_url="https://api.example.invalid/v1"',
        "-c", 'model_providers.provider-a.env_key="MODEL_SERVICE_TOKEN"'],
      environment: ["MODEL_SERVICE_TOKEN"], capabilities: ["external-provider"],
    } } } : {}),
  });
  const session = makeSession({
    name: "agent-a",
    dir: root,
    agent: "codex",
    runtime: "app-server",
    chatEnabled: true,
  });
  await writeSessionsUnlocked(machine, [session]);
  const native = new OwnedCodexProjection(machine, session, process.pid);
  native.reconcile({ type: "idle" }, 0);
  native.event({
    method: "item/completed",
    params: {
      threadId: session.uuid,
      turnId: "turn-a",
      item: { id: "assistant-a", type: "agentMessage", text: "ready" },
    },
  });
  const writer = new OwnedCodexStatusWriter(machine, session.name);
  await writer.write(native.snapshot());
  const publisher = new ControlPublisher(machine);
  const monitoring = new MonitoringPublisher();
  const publish = async () => {
    monitoring.begin(machine);
    monitoring.sample(machine, session, 1, "❯\n? for shortcuts", UNSEEN);
    publisher.publish(machine, await monitoring.publish(machine));
  };
  await publish();
  let createCalls = 0;
  const owned = createControlServer(
    machine,
    publisher,
    undefined,
    () => machine,
    new ExternalStatusPublisher(machine.rcPrefix),
    {
      createManagedSession: async (_current, input) => {
        createCalls++;
        await Bun.sleep(10);
        const created = makeSession({
          name: input.name,
          dir: input.dir,
          uuid: crypto.randomUUID(),
          agent: "codex",
          runtime: "app-server",
          registrationGeneration: input.registrationGeneration,
          chatEnabled: true,
          flags: input.flags,
          envFile: input.envFile,
          launchRecipe: input.launchRecipe,
        });
        await writeSessionsUnlocked(machine, [...loadSessions(machine), created]);
        return created;
      },
    },
  );
  const socket = controlSocket(machine);
  const local = createControlClient({ socket });
  const servicePayloads: string[] = [];
  const remote = createCcmuxControlServiceClient(async (url, init) => {
    const route = new URL(String(url));
    const operation = ControlServiceOperationSchema.parse(
      route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
    );
    const payload = typeof init?.body === "string" ? init.body : "{}";
    servicePayloads.push(payload);
    return fetch("http://ccmux.local/ccmux-control/v1/invoke", {
      unix: socket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        caller: "host-b",
        service: "ccmux.control",
        revision: "1",
        operation,
        payload,
      }),
    });
  });
  const target = managedPeer(machine.rcPrefix, session);
  cleanup.push(async () => {
    await local.close();
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await owned.observability.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, machine, session, native, writer, publisher, publish, owned, socket, local, remote, target,
    recipeEnvFile, recipeSecret, servicePayloads, createCalls: () => createCalls };
}

test("declared service activates a host-owned recipe without carrying its environment source or value", async () => {
  const f = await fixture({ launchRecipe: true });
  const receipt = await f.remote.create({
    requestId: crypto.randomUUID(), name: "recipe-a", workspace: f.root, flags: [],
    launchRecipe: { id: "provider-a", revision: "r1" },
  });
  expect(receipt.launchRecipe).toMatchObject({ id: "provider-a", revision: "r1", capabilities: ["external-provider"] });
  const wire = f.servicePayloads.at(-1) ?? "";
  expect(wire).not.toContain(f.recipeSecret);
  expect(wire).not.toContain(f.recipeEnvFile);
  expect(JSON.stringify(receipt)).not.toContain(f.recipeSecret);
  expect(JSON.stringify(receipt)).not.toContain(f.recipeEnvFile);
  expect(f.createCalls()).toBe(1);
});

test("declared service reuses exact control operations, identity and admission", async () => {
  const f = await fixture();
  expect(await f.remote.get({ target: f.target })).toEqual(await f.local.get({ target: f.target }));
  expect(await f.remote.native({ target: f.target, cursor: null })).toEqual(
    await f.local.native({ target: f.target, cursor: null }),
  );
  const messageId = crypto.randomUUID();
  expect(await f.remote.message({ target: f.target, messageId, body: "service message" })).toEqual({
    messageId,
    accepted: true,
    duplicate: false,
  });
  expect(await f.remote.message({ target: f.target, messageId, body: "service message" })).toEqual({
    messageId,
    accepted: true,
    duplicate: true,
  });
  expect(loadLedger(f.machine)).toHaveLength(1);
  expect(loadLedger(f.machine)[0]?.from).toEqual({ kind: "cli", source: "ccmux", machine: "host-b" });
  const requestId = crypto.randomUUID();
  const firstCreate = f.remote.create({ requestId, name: "created-a", workspace: f.root, flags: [] });
  for (let attempt = 0; attempt < 50 && f.owned.controls.mutations.getSnapshot().active === 0; attempt++)
    await Bun.sleep(1);
  await expect(
    f.remote.create({ requestId, name: "created-a", workspace: f.root, flags: [] }),
  ).rejects.toMatchObject({ code: "BUSY", status: 429 });
  const created = await firstCreate;
  const duplicate = await f.remote.create({ requestId, name: "created-a", workspace: f.root, flags: [] });
  expect(f.createCalls()).toBe(1);
  expect(created.target).toEqual(duplicate.target);
  expect([created.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
  f.owned.controls.mutations.stopAdmission();
  await expect(
    f.remote.message({ target: f.target, messageId: crypto.randomUUID(), body: "after drain" }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
});

test("service envelope, effect, nested selector, size and stale identity fail closed", async () => {
  const f = await fixture();
  const invoke = (body: unknown) =>
    fetch("http://ccmux.local/ccmux-control/v1/invoke", {
      unix: f.socket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const base = {
    v: 1,
    id: crypto.randomUUID(),
    caller: "host-b",
    service: "ccmux.control",
    revision: "1",
    operation: "session.get",
    payload: JSON.stringify({ target: f.target }),
  };
  expect((await invoke({ ...base, revision: "2" })).status).toBe(400);
  expect((await invoke({ ...base, operation: "unknown" })).status).toBe(400);
  expect(
    (await invoke({ ...base, payload: JSON.stringify({ target: f.target, operation: "session.archive" }) })).status,
  ).toBe(400);
  expect((await invoke({ ...base, payload: "x".repeat(70_000) })).status).toBe(400);
  expect(() =>
    ControlServiceDescriptorSchema.parse({
      ...ccmuxControlServiceDescriptor,
      operations: ccmuxControlServiceDescriptor.operations.map((operation) =>
        operation.id === "session.get" ? { ...operation, effect: "session.create" } : operation,
      ),
    }),
  ).toThrow("wrong effect");

  f.native.request({
    id: "approval-a",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: f.session.uuid,
      turnId: "turn-a",
      itemId: "tool-a",
      startedAtMs: Date.now(),
      reason: "confirm",
      availableDecisions: ["accept", "decline"],
    },
  });
  await f.writer.write(f.native.snapshot());
  await f.publish();
  await expect(
    f.remote.respond({
      target: f.target,
      operationId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      requestId: "s:approval-a",
      kind: "approval",
      decision: "decline",
      answers: null,
    }),
  ).rejects.toMatchObject({ code: "STALE_REQUEST", status: 409 });
});

test("native stream cursor binds target and source adapter resumes, heartbeats and cancels", async () => {
  const f = await fixture();
  const config = join(f.root, "machine.json");
  writeFileSync(config, JSON.stringify(f.machine));

  const run = (cursor: string | null) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/cli.ts", "control-native-stream"], {
      cwd: import.meta.dir + "/..",
      env: {
        ...process.env,
        CCMUX_CONFIG: config,
      },
      stdin: new TextEncoder().encode(JSON.stringify({ target: f.target, cursor })),
      stdout: "pipe",
      stderr: "pipe",
    });
    return child;
  };
  const nextFrame = async (
    child: ReturnType<typeof run>,
    iterator: AsyncIterator<unknown>,
    label: string,
  ) => {
    const next = await iterator.next();
    if (!next.done && next.value !== undefined)
      return ControlNativeStreamFrameSchema.parse(next.value);
    child.kill("SIGTERM");
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    throw new Error(`${label} stream ended ${code}: ${error}`);
  };

  const first = run(null);
  const firstFrames = parseNDJSON<unknown>(new Response(first.stdout), { maxLineBytes: 2 * 1024 * 1024 })[
    Symbol.asyncIterator
  ]();
  const initial = await nextFrame(first, firstFrames, "initial");
  const initialSnapshot = JSON.parse(initial.data);
  expect(initialSnapshot).toMatchObject({ target: f.target, reset: "initial" });
  expect(readControlNativeStreamCursor(initial.cursor, f.target)).toEqual({
    generation: initialSnapshot.generation,
    sequence: initialSnapshot.sequence,
  });
  await Bun.sleep(2100);
  const heartbeat = await nextFrame(first, firstFrames, "heartbeat");
  expect(heartbeat).toEqual(initial);
  first.kill("SIGTERM");
  expect(await first.exited).toBe(0);
  expect(await new Response(first.stderr).text()).toBe("");

  const resumed = run(initial.cursor);
  const resumedFrames = parseNDJSON<unknown>(new Response(resumed.stdout), { maxLineBytes: 2 * 1024 * 1024 })[
    Symbol.asyncIterator
  ]();
  const resumedFrame = await nextFrame(resumed, resumedFrames, "resume");
  expect(JSON.parse(resumedFrame.data)).toMatchObject({ target: f.target, reset: null, items: [] });
  resumed.kill("SIGTERM");
  expect(await resumed.exited).toBe(0);

  f.native.reconcile({ type: "idle" }, f.native.revision);
  await f.writer.write(f.native.snapshot());
  await f.publish();
  const gapCursor = encodeControlNativeStreamCursor(f.target, {
    generation: initialSnapshot.generation,
    sequence: initialSnapshot.sequence + 10_000,
  });
  const gap = run(gapCursor);
  const gapFrames = parseNDJSON<unknown>(new Response(gap.stdout), { maxLineBytes: 2 * 1024 * 1024 })[
    Symbol.asyncIterator
  ]();
  const gapFrame = await nextFrame(gap, gapFrames, "gap");
  expect(JSON.parse(gapFrame.data).reset).toBe("gap");
  gap.kill("SIGTERM");
  expect(await gap.exited).toBe(0);

  expect(() => readControlNativeStreamCursor(initial.cursor, { ...f.target, session: "other" })).toThrow(
    "another target",
  );
  expect(managedPeerKey(initialSnapshot.target)).toBe(managedPeerKey(f.target));
}, 15_000);
