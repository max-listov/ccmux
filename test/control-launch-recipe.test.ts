import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCreateSchema } from "../src/control/schema.ts";
import { createControlSession } from "../src/control/lifecycle.ts";
import { resolveControlLaunchRecipe, verifyManagedLaunchRecipe } from "../src/config/launchRecipes.ts";
import { loadSessions, writeSessionsUnlocked } from "../src/config/sessions.ts";
import { ownedCodexArgv } from "../src/agent/codex/ownedLaunch.ts";
import { ControlPublisher } from "../src/control/publisher.ts";
import { MonitoringPublisher } from "../src/monitoring/publish.ts";
import { UNSEEN } from "../src/events/observe.ts";
import { OwnedCodexProjection } from "../src/agent/codex/ownedProjection.ts";
import { OwnedCodexStatusWriter } from "../src/agent/codex/ownedStatus.ts";
import { readControlNative } from "../src/control/nativeFeed.ts";
import { managedPeer } from "../src/chat/identity.ts";
import type { CreateManagedInput } from "../src/commands/create.ts";
import { makeMachine, makeSession } from "./helpers.ts";

const FIXTURE_SECRET = "fixture-secret-value-never-public";

function configured(root: string) {
  const envFile = join(root, "provider.env");
  writeFileSync(envFile, `MODEL_SERVICE_TOKEN=${FIXTURE_SECRET}\n`);
  const definition = {
    revision: "r1",
    envFile,
    flags: [
      "-c", 'model_provider="provider-a"',
      "-c", 'model_providers.provider-a.name="Provider A"',
      "-c", 'model_providers.provider-a.base_url="https://api.example.invalid/v1"',
      "-c", 'model_providers.provider-a.env_key="MODEL_SERVICE_TOKEN"',
      "-c", 'model_providers.provider-a.wire_api="responses"',
    ],
    environment: ["MODEL_SERVICE_TOKEN"],
    capabilities: ["responses", "external-provider"],
  };
  return {
    envFile,
    definition,
    machine: makeMachine({
      stateDir: join(root, "state"),
      rcPrefix: "host-a",
      codexBin: "/bin/codex",
      launchRecipes: { "provider-a": definition },
    }),
  };
}

test("public create accepts only a safe immutable recipe reference", () => {
  const safe = { requestId: crypto.randomUUID(), name: "agent-a", workspace: "/work", flags: [],
    launchRecipe: { id: "provider-a", revision: "r1" } };
  expect(ControlCreateSchema.parse(safe).launchRecipe).toEqual({ id: "provider-a", revision: "r1" });
  for (const extra of [
    { envFile: "/tmp/private.env" }, { executable: "/bin/codex" }, { shell: "echo no" },
    { environment: { MODEL_SERVICE_TOKEN: FIXTURE_SECRET } },
  ]) expect(() => ControlCreateSchema.parse({ ...safe, launchRecipe: { ...safe.launchRecipe, ...extra } })).toThrow();
});

test("host recipe reuses flags and envFile without putting secret values in public metadata or argv", () => {
  const root = mkdtempSync("/tmp/ccmux-recipe-resolve-");
  try {
    const f = configured(root);
    const resolved = resolveControlLaunchRecipe(f.machine, root, { id: "provider-a", revision: "r1" }, []);
    expect(resolved.envFile).toBe(f.envFile);
    expect(resolved.launchRecipe).toMatchObject({ id: "provider-a", revision: "r1",
      capabilities: ["external-provider", "responses"] });
    expect(resolved.launchRecipe?.digest).toHaveLength(64);
    const session = makeSession({ name: "agent-a", dir: root, agent: "codex", runtime: "app-server",
      flags: resolved.flags, envFile: resolved.envFile, launchRecipe: resolved.launchRecipe });
    verifyManagedLaunchRecipe(f.machine, session);
    const outward = JSON.stringify(resolved.launchRecipe);
    const argv = JSON.stringify(ownedCodexArgv(session, f.machine));
    expect(outward).not.toContain(FIXTURE_SECRET);
    expect(outward).not.toContain(f.envFile);
    expect(argv).not.toContain(FIXTURE_SECRET);
    expect(argv).toContain("MODEL_SERVICE_TOKEN");
    expect(() => resolveControlLaunchRecipe(f.machine, root, { id: "provider-a", revision: "r1" }, ["--model", "other"]))
      .toThrow("Launch recipe owns native configuration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recipe create is one-writer idempotent and rejects unknown, removed or changed definitions before spawn", async () => {
  const root = mkdtempSync("/tmp/ccmux-recipe-create-");
  try {
    const f = configured(root);
    const requestId = crypto.randomUUID();
    let calls = 0;
    const create = async (_machine: typeof f.machine, input: CreateManagedInput) => {
      calls++;
      await Bun.sleep(10);
      const session = makeSession({ name: input.name, dir: input.dir, uuid: crypto.randomUUID(), agent: "codex",
        runtime: "app-server", registrationGeneration: input.registrationGeneration, chatEnabled: true,
        flags: input.flags, envFile: input.envFile, launchRecipe: input.launchRecipe });
      await writeSessionsUnlocked(f.machine, [session]);
      return session;
    };
    const input = { requestId, name: "agent-a", workspace: root, flags: [],
      launchRecipe: { id: "provider-a", revision: "r1" } };
    const [first, second] = await Promise.all([
      createControlSession(f.machine, input, new AbortController().signal, create),
      createControlSession(f.machine, input, new AbortController().signal, create),
    ]);
    expect(calls).toBe(1);
    expect(first.target).toEqual(second.target);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.launchRecipe).toEqual(second.launchRecipe);
    expect(JSON.stringify(first)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(first)).not.toContain(f.envFile);

    const restartedMachine = makeMachine({ ...f.machine });
    const restarted = await createControlSession(restartedMachine, input, new AbortController().signal, create);
    expect(restarted.target).toEqual(first.target);
    expect(restarted.duplicate).toBe(true);
    expect(calls).toBe(1);

    const changed = makeMachine({ ...f.machine, launchRecipes: { "provider-a": {
      ...f.definition, flags: [...f.definition.flags, "-c", 'model="changed"'],
    } } });
    await expect(createControlSession(changed, input, new AbortController().signal, create))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls).toBe(1);
    const persisted = loadSessions(f.machine)[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) throw new Error("persisted recipe session missing");
    expect(() => verifyManagedLaunchRecipe(changed, persisted)).toThrow("Launch recipe is unavailable");

    const removed = makeMachine({ ...f.machine, launchRecipes: {} });
    await expect(createControlSession(removed, input, new AbortController().signal, create))
      .rejects.toMatchObject({ code: "LAUNCH_RECIPE_UNAVAILABLE", message: "Launch recipe is unavailable" });
    const unknownRoot = mkdtempSync("/tmp/ccmux-recipe-unknown-");
    try {
      const unknown = makeMachine({ ...removed, stateDir: join(unknownRoot, "state") });
      await expect(createControlSession(unknown, { ...input, requestId: crypto.randomUUID(), workspace: unknownRoot },
        new AbortController().signal, create)).rejects.toMatchObject({ code: "LAUNCH_RECIPE_UNAVAILABLE" });
      expect(loadSessions(unknown)).toEqual([]);
    } finally { rmSync(unknownRoot, { recursive: true, force: true }); }

    const unavailableRoot = mkdtempSync("/tmp/ccmux-recipe-unavailable-");
    try {
      const unavailable = makeMachine({ ...f.machine, stateDir: join(unavailableRoot, "state"),
        launchRecipes: { "provider-a": { ...f.definition, envFile: join(unavailableRoot, "missing.env") } } });
      await expect(createControlSession(unavailable, { ...input, requestId: crypto.randomUUID(), workspace: unavailableRoot },
        new AbortController().signal, create)).rejects.toMatchObject({ code: "LAUNCH_RECIPE_UNAVAILABLE" });
      expect(loadSessions(unavailable)).toEqual([]);
    } finally { rmSync(unavailableRoot, { recursive: true, force: true }); }
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status and native projections expose the same safe recipe metadata only", async () => {
  const root = mkdtempSync("/tmp/ccmux-recipe-projection-");
  try {
    const f = configured(root);
    const resolved = resolveControlLaunchRecipe(f.machine, root, { id: "provider-a", revision: "r1" }, []);
    const session = makeSession({ name: "agent-a", dir: root, agent: "codex", runtime: "app-server",
      flags: resolved.flags, envFile: resolved.envFile, launchRecipe: resolved.launchRecipe });
    await writeSessionsUnlocked(f.machine, [session]);
    const native = new OwnedCodexProjection(f.machine, session, process.pid);
    native.reconcile({ type: "idle" }, 0);
    await new OwnedCodexStatusWriter(f.machine, session.name).write(native.snapshot());
    const monitoring = new MonitoringPublisher();
    monitoring.begin(f.machine);
    monitoring.sample(f.machine, session, 1, "❯\n? for shortcuts", UNSEEN);
    const publisher = new ControlPublisher(f.machine);
    publisher.publish(f.machine, await monitoring.publish(f.machine));
    const row = publisher.read().sessions[0];
    const projection = readControlNative(f.machine, managedPeer(f.machine.rcPrefix, session), null);
    expect(row?.launchRecipe).toEqual(resolved.launchRecipe);
    expect(projection.launchRecipe).toEqual(resolved.launchRecipe);
    for (const outward of [JSON.stringify(row), JSON.stringify(projection)]) {
      expect(outward).not.toContain(FIXTURE_SECRET);
      expect(outward).not.toContain(f.envFile);
    }
    publisher.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
