#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeMachine, makeSession } from "../test/helpers.ts";
import { writeSessionsUnlocked } from "../src/config/sessions.ts";
import { managedPeer } from "../src/chat/identity.ts";
import { UNSEEN } from "../src/events/observe.ts";
import { MonitoringPublisher } from "../src/monitoring/publish.ts";
import { ControlPublisher } from "../src/control/publisher.ts";
import { createControlServer } from "../src/control/server.ts";
import { createControlClient } from "../src/control/client.ts";
import { controlSocket } from "../src/control/path.ts";

/** Explicit provider E2E: one real connected App Server serves its catalog through the control
 * read. Read-only; it starts no turn, spends no provider usage and targets no real session. */
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const root = mkdtempSync(join(tmpdir(), "ccmux-models-probe-"));
const codexHome = join(homedir(), ".codex");
check(existsSync(join(codexHome, "app-server-control", "app-server-control.sock")), "No connected App Server control socket");
const m = makeMachine({ stateDir: join(root, "state"), rcPrefix: "probe", projectsDir: join(root, "history"),
  codexHome, codexSessionsDir: join(root, "codex-sessions") });
const session = makeSession({ name: "agent-a", dir: join(root, "workspace"), agent: "codex", runtime: "app-server" });
await writeSessionsUnlocked(m, [session]);
const monitoring = new MonitoringPublisher();
const publisher = new ControlPublisher(m);
let client: ReturnType<typeof createControlClient> | undefined;
try {
  monitoring.begin(m);
  monitoring.sample(m, session, 1, "❯\n? for shortcuts", UNSEEN);
  publisher.publish(m, await monitoring.publish(m));
  const owned = createControlServer(m, publisher);
  client = createControlClient({ socket: controlSocket(m) });
  const target = managedPeer(m.rcPrefix, session);

  const first = await client.models({ target, limit: 2 });
  check(JSON.stringify(first.target) === JSON.stringify(target), "Target echo mismatch");
  check(first.data.length === 2, `Expected a two-model first page, got ${first.data.length}`);
  check(typeof first.nextCursor === "string" && first.nextCursor.length > 0, "Provider page did not continue");
  const second = await client.models({ target, cursor: first.nextCursor, limit: 2 });
  check(second.data.length === 2, "Second page was empty");
  check(new Set([...first.data, ...second.data].map((model) => model.id)).size === 4, "Pagination repeated a model");

  const full = await client.models({ target });
  check(full.nextCursor === null, "Full page still reported a continuation cursor");
  check(full.data.length >= 4, "Full catalog smaller than its own pagination");
  const defaults = full.data.filter((model) => model.isDefault);
  check(defaults.length === 1, `Expected exactly one default model, got ${defaults.length}`);
  const safeKeys = ["id", "displayName", "description", "hidden", "isDefault", "inputModalities",
    "serviceTiers", "supportedReasoningEfforts", "defaultReasoningEffort"];
  check(full.data.every((model) => Object.keys(model).every((key) => safeKeys.includes(key))),
    "Unsafe provider fields crossed the boundary");
  const hidden = await client.models({ target, includeHidden: true });
  check(hidden.data.length >= full.data.length, "includeHidden returned fewer models");
  const wire = JSON.stringify(hidden);
  check(!wire.includes(root) && !wire.includes(homedir()) && !wire.includes("auth.json"),
    "Response leaked machine configuration");

  console.log(JSON.stringify({
    probe: "control-models-e2e",
    connected: true,
    visibleModels: full.data.length,
    hiddenModels: hidden.data.length - full.data.length,
    defaultModel: defaults[0]?.id ?? null,
    paginatedRoundTrip: true,
    boundedSafeFieldsOnly: true,
    noMachineConfigurationInResponse: true,
  }, null, 2));

  await client.close();
  await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
  await owned.observability.close();
  publisher.close();
} finally {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
}
