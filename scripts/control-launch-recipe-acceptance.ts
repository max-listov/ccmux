#!/usr/bin/env bun
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { createCcmuxControlServiceClient, CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceOperationSchema } from "../src/control/serviceDescriptor.ts";
import { controlSocket } from "../src/control/path.ts";
import { hasSession, killSession, newSession } from "../src/tmux/tmux.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";

const configArgument = process.argv[2];
if (configArgument === undefined || !basename(dirname(configArgument)).startsWith("ccmux-owned-probe-"))
  throw new Error("Pass an isolated owned-runtime probe machine.json");
const config = configArgument;
const root = dirname(config);
const cli = process.argv[3] ?? join(process.cwd(), "src/cli.ts");
const recipeId = "provider-a";
const revision = "r1";
const secret = `fixture-${crypto.randomUUID()}-never-public`;
const envFile = join(root, "provider.env");
const requestId = crypto.randomUUID();
const sessionName = `recipe-${crypto.randomUUID().slice(0, 8)}`;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base = MachineConfigSchema.parse(JSON.parse(readFileSync(config, "utf8")));
check(base.stateDir === join(root, "state") && base.tmuxSocket?.startsWith("ccmux-owned-"), "probe is not isolated");
check(base.telegram === undefined && Object.keys(base.fleet ?? {}).length === 0, "probe has external delivery configured");
const definition = {
  revision,
  envFile,
  flags: [
    "-c", `model_provider="${recipeId}"`,
    "-c", `model_providers.${recipeId}.name="Provider A"`,
    "-c", `model_providers.${recipeId}.base_url="http://127.0.0.1:9/v1"`,
    "-c", `model_providers.${recipeId}.env_key="MODEL_SERVICE_TOKEN"`,
    "-c", `model_providers.${recipeId}.wire_api="responses"`,
  ],
  environment: ["MODEL_SERVICE_TOKEN"],
  capabilities: ["external-provider", "responses"],
};

const environment: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: base.stateDir,
  CCMUX_CACHE_DIR: join(root, "cache"),
  CCMUX_DATA_DIR: join(root, "data"),
};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && environment[key] === undefined) environment[key] = value;
for (const key of ["CCMUX_SESSION", "CCMUX_CHAT_CREDENTIAL", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"])
  delete environment[key];

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function command(args: string[], timeoutMs = 60_000): Promise<string> {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}\n${stdout}`);
  return stdout;
}

async function writeMachine(machine: typeof base): Promise<void> {
  await Bun.write(config, `${JSON.stringify(machine, null, 2)}\n`);
}

async function restartDaemon(machine: typeof base): Promise<void> {
  await killSession(machine, "probe-daemon");
  await waitFor("old daemon tmux session stopped", async () => !(await hasSession(machine, "probe-daemon")), 10_000);
  await Bun.sleep(300);
  await newSession(machine, "probe-daemon", root,
    [process.execPath, "--no-env-file", cli, "daemon"], environment);
  await waitFor("control service restarted", async () => {
    try {
      const response = await fetch("http://ccmux.local/control/sessions", { unix: controlSocket(machine) });
      return response.ok;
    } catch { return false; }
  });
}

let activeMachine = MachineConfigSchema.parse({ ...base, launchRecipes: { [recipeId]: definition } });
await Bun.write(envFile, `MODEL_SERVICE_TOKEN=${secret}\n`);
await writeMachine(activeMachine);
await restartDaemon(activeMachine);

const payloads: string[] = [];
const remote = createCcmuxControlServiceClient(async (url, init) => {
  const route = new URL(String(url));
  const operation = ControlServiceOperationSchema.parse(
    route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
  );
  const payload = typeof init?.body === "string" ? init.body : "{}";
  payloads.push(payload);
  return fetch("http://ccmux.local/ccmux-control/v1/invoke", {
    unix: controlSocket(activeMachine), method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), caller: activeMachine.rcPrefix,
      service: "ccmux.control", revision: "1", operation, payload }),
  });
});

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try { await run(); }
  catch (error) {
    check(typeof error === "object" && error !== null && "code" in error && error.code === code,
      `Expected ${code}, got ${String(error)}`);
    return;
  }
  throw new Error(`Expected ${code}, call succeeded`);
}

let target: Awaited<ReturnType<typeof remote.create>>["target"] | null = null;
let archived = false;
try {
  const createInput = { requestId, name: sessionName, workspace: root, flags: [],
    launchRecipe: { id: recipeId, revision } };
  const created = await remote.create(createInput);
  target = created.target;
  const retried = await remote.create(createInput);
  check(!created.duplicate && retried.duplicate, "same request did not reconcile as one create");
  check(JSON.stringify(created.target) === JSON.stringify(retried.target), "retry changed managed identity");
  check(created.launchRecipe?.id === recipeId && created.launchRecipe.revision === revision,
    "create receipt omitted safe recipe identity");
  check(created.launchRecipe.digest === retried.launchRecipe?.digest, "retry changed recipe digest");

  const session = loadSessions(activeMachine).find((row) => row.name === sessionName);
  check(session !== undefined && session.launchRecipe?.digest === created.launchRecipe.digest,
    "registry did not persist recipe identity");
  await waitFor("recipe native projection", () => readOwnedCodexStatus(activeMachine, session).status === "live");
  const before = readOwnedCodexStatus(activeMachine, session).snapshot;
  check(before !== null, "recipe session has no native baseline");
  let row: Awaited<ReturnType<typeof remote.get>> | null = null;
  let native: Awaited<ReturnType<typeof remote.native>> | null = null;
  await waitFor("recipe control projection", async () => {
    try {
      [row, native] = await Promise.all([
        remote.get({ target: target! }),
        remote.native({ target: target!, cursor: null }),
      ]);
      return true;
    } catch { return false; }
  }, 45_000);
  check(row !== null && native !== null, "recipe control projection remained unavailable");
  for (const outward of [JSON.stringify(created), JSON.stringify(row), JSON.stringify(native), ...payloads]) {
    check(!outward.includes(secret), "secret value crossed the public control boundary");
    check(!outward.includes(envFile), "recipe env path crossed the public control boundary");
  }
  const processArgv = Bun.spawnSync(["ps", "-p", String(before.providerPid), "-o", "command="], {
    stdout: "pipe", stderr: "pipe",
  }).stdout.toString();
  check(!processArgv.includes(secret), "secret value reached provider argv");
  check(processArgv.includes("MODEL_SERVICE_TOKEN"), "provider argv lost the configured environment key name");

  await command(["restart", sessionName]);
  await waitFor("recipe restart", () => {
    const next = readOwnedCodexStatus(activeMachine, session).snapshot;
    return next !== null && next.providerPid !== before.providerPid && next.generation !== before.generation;
  });
  const after = readOwnedCodexStatus(activeMachine, session).snapshot;
  check(after?.threadId === session.uuid, "recipe restart changed provider identity");
  check((await remote.get({ target })).launchRecipe?.digest === created.launchRecipe.digest,
    "recipe restart changed safe metadata");

  await restartDaemon(activeMachine);
  const daemonRetry = await remote.create(createInput);
  check(daemonRetry.duplicate && JSON.stringify(daemonRetry.target) === JSON.stringify(target),
    "daemon restart did not reconcile the accepted identity");
  check(daemonRetry.launchRecipe?.digest === created.launchRecipe.digest,
    "daemon restart changed the accepted recipe digest");

  const registryBeforeUnknown = loadSessions(activeMachine).length;
  const unknownName = `unknown-${crypto.randomUUID().slice(0, 8)}`;
  await expectCode(() => remote.create({ requestId: crypto.randomUUID(), name: unknownName, workspace: root,
    flags: [], launchRecipe: { id: "missing-recipe", revision } }), "LAUNCH_RECIPE_UNAVAILABLE");
  check(loadSessions(activeMachine).length === registryBeforeUnknown && !(await hasSession(activeMachine, unknownName)),
    "unknown recipe mutated registry or spawned a session");

  activeMachine = MachineConfigSchema.parse({ ...activeMachine, launchRecipes: { [recipeId]: {
    ...definition, flags: [...definition.flags, "-c", 'model="changed"'],
  } } });
  await writeMachine(activeMachine);
  await restartDaemon(activeMachine);
  await expectCode(() => remote.create(createInput), "IDEMPOTENCY_CONFLICT");
  check(loadSessions(activeMachine).find((item) => item.name === sessionName)?.uuid === session.uuid,
    "changed recipe altered accepted identity");

  activeMachine = MachineConfigSchema.parse({ ...activeMachine, launchRecipes: {} });
  await writeMachine(activeMachine);
  await restartDaemon(activeMachine);
  await expectCode(() => remote.create(createInput), "LAUNCH_RECIPE_UNAVAILABLE");

  activeMachine = MachineConfigSchema.parse({ ...activeMachine, launchRecipes: { [recipeId]: definition } });
  await writeMachine(activeMachine);
  await restartDaemon(activeMachine);
  const archive = await remote.archive({ target });
  archived = archive.archived;
  check(archived, "recipe session archive failed");
  check(!readFileSync(join(activeMachine.stateDir, "ccmux.log"), "utf8").includes(secret),
    "secret value reached owner service logs");

  console.log(JSON.stringify({ ok: true, identityHash: hash(`${target.machine}:${target.session}:${target.threadId}`),
    recipeDigest: created.launchRecipe.digest, oneWriter: true, retryDuplicate: retried.duplicate,
    safeProjection: true, safeArgv: true, restartSameIdentity: true, daemonRetry: true, unknownBeforeSpawn: true,
    changedConflict: true, removedUnavailable: true, archived }));
} finally {
  if (target !== null && !archived) await remote.archive({ target }).catch(() => {});
}
