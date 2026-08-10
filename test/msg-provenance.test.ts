import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chatAuthPath, sessionsPath } from "../src/config/paths.ts";
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from "../src/chat/auth.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadLedger } from "../src/chat/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// A config + registry with three chat-enabled sessions: a router, a plain peer, and a target.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-prov-"));
  const cfg = { claudeBin: "/bin/claude", tmuxBin: "/bin/tmux", projectsDir: "/p", rcPrefix: "test", stateDir: dir, bootLabel: "b" };
  const cfgPath = join(dir, "machine.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const row = (name: string, extra: object) =>
    JSON.stringify({ name, dir: "/tmp/x", uuid: randomUUID(), agent: "claude", chatEnabled: true, ...extra });
  const m = MachineConfigSchema.parse(cfg);
  writeFileSync(
    sessionsPath(m),
    `${row("router", { promptModules: ["router"] })}\n${row("peer", {})}\n${row("worker", {})}\n`,
  );
  for (const session of loadSessions(m)) rotateChatCredential(m, session);
  return { cfgPath, m };
}

async function runMsg(cfgPath: string, session: string | undefined, args: string[]): Promise<number> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) {
    env.CCMUX_SESSION = session;
    const m = MachineConfigSchema.parse(JSON.parse(await Bun.file(cfgPath).text()));
    const managed = loadSessions(m).find((item) => item.name === session);
    if (managed !== undefined) env[CHAT_CREDENTIAL_ENV] = (await Bun.file(chatAuthPath(m, managed.name)).text()).trim();
  }
  else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(["bun", CLI, "msg", ...args], { env, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  return await proc.exited;
}

test("a router session MAY relay --on-behalf-of owner", async () => {
  const { cfgPath, m } = setup();
  const code = await runMsg(cfgPath, "router", ["worker", "--defer", "--on-behalf-of", "owner", "do X"]);
  expect(code).toBe(0);
  const led = loadLedger(m);
  expect(led.at(-1)).toMatchObject({
    from: { kind: "managed", source: "ccmux", machine: "test", agent: "claude", session: "router" },
    to: { kind: "managed", source: "ccmux", machine: "test", agent: "claude", session: "worker" },
    onBehalfOf: "owner",
    defer: true,
  });
});

test("a plain peer session may NOT forge --on-behalf-of owner", async () => {
  const { cfgPath, m } = setup();
  const code = await runMsg(cfgPath, "peer", ["worker", "--on-behalf-of", "owner", "sneaky"]);
  expect(code).toBe(1); // rejected — not a router
  expect(loadLedger(m).length).toBe(0); // nothing written
});

test("self-setting CCMUX_SESSION without its capability cannot promote cli to managed", async () => {
  const { cfgPath, m } = setup();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = cfgPath;
  env.CCMUX_SESSION = "router";
  delete env[CHAT_CREDENTIAL_ENV];
  const proc = Bun.spawn(["bun", CLI, "msg", "worker", "forged"], { env, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(1);
  expect(loadLedger(m)).toHaveLength(0);
});

test("the cli (human operator) MAY relay --on-behalf-of", async () => {
  const { cfgPath, m } = setup();
  const code = await runMsg(cfgPath, undefined, ["worker", "--on-behalf-of", "owner", "human relay"]);
  expect(code).toBe(0);
  expect(loadLedger(m).at(-1)).toMatchObject({ from: { kind: "cli", source: "ccmux", machine: "test" }, onBehalfOf: "owner" });
});

test("--after sets a future notBefore (the router's self-watchdog timer)", async () => {
  const { cfgPath, m } = setup();
  const before = Date.now();
  const code = await runMsg(cfgPath, "router", ["router", "--after", "120", "--task", "r1", "WATCHDOG r1"]);
  expect(code).toBe(0);
  const last = loadLedger(m).at(-1);
  expect(last).toBeDefined();
  const nb = last?.notBefore ?? null;
  expect(nb).not.toBeNull();
  if (nb !== null) expect(Date.parse(nb)).toBeGreaterThan(before + 100_000); // ~120s ahead
  expect(last?.to).toMatchObject({ kind: "managed", machine: "test", agent: "claude", session: "router" }); // a self-ping
});

test("--after rejects a non-positive value", async () => {
  const { cfgPath, m } = setup();
  expect(await runMsg(cfgPath, "router", ["worker", "--after", "0", "x"])).toBe(1);
  expect(loadLedger(m).length).toBe(0);
});
