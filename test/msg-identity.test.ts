import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendMessage, loadLedger } from "../src/chat/store.ts";
import { managedPeer } from "../src/chat/identity.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { sessionsPath } from "../src/config/paths.ts";
import { makeChatMessage, makeCli, makeSession } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const RECEIVE_FIXTURE = join(import.meta.dir, "fixtures", "receive-chat.ts");

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "ccmux-identity-"));
  const configPath = join(stateDir, "machine.json");
  const machine = MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    codexBin: "/bin/codex",
    tmuxBin: "/bin/tmux",
    projectsDir: "/tmp/claude",
    codexSessionsDir: "/tmp/codex",
    rcPrefix: "host-a",
    stateDir,
    bootLabel: "ccmux.service",
  });
  writeFileSync(configPath, JSON.stringify(machine));
  const target = makeSession({ name: "worker", agent: "claude", uuid: randomUUID(), chatEnabled: true });
  writeFileSync(sessionsPath(machine), `${JSON.stringify(target)}\n`);
  return { configPath, machine, target };
}

async function receive(configPath: string, envelope: string): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  delete env.CCMUX_SESSION;
  const processHandle = Bun.spawn(["bun", RECEIVE_FIXTURE], {
    env,
    stdin: new Response(envelope),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(processHandle.stdout).text();
  const stderr = await new Response(processHandle.stderr).text();
  return { code: await processHandle.exited, output: `${stdout}${stderr}` };
}

test("transport receive accepts the exact provider+UUID endpoint once", async () => {
  const { configPath, machine, target } = setup();
  const envelope = makeChatMessage({
    id: randomUUID(),
    from: makeCli("host-b"),
    to: managedPeer(machine.rcPrefix, target),
  });
  expect((await receive(configPath, JSON.stringify(envelope))).code).toBe(0);
  expect((await receive(configPath, JSON.stringify(envelope))).code).toBe(0);
  expect(loadLedger(machine)).toHaveLength(1);
});

test("concurrent retries append one envelope exactly once", async () => {
  const { configPath, machine, target } = setup();
  const envelope = JSON.stringify(makeChatMessage({ id: randomUUID(), from: makeCli("host-b"), to: managedPeer(machine.rcPrefix, target) }));
  const results = await Promise.all(Array.from({ length: 8 }, () => receive(configPath, envelope)));
  expect(results.every((result) => result.code === 0)).toBe(true);
  expect(loadLedger(machine)).toHaveLength(1);
});

test("receiver rejects a local invocation even when it self-sets SSH_CONNECTION", async () => {
  const { configPath, machine, target } = setup();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  delete env.CCMUX_SESSION;
  env.SSH_CONNECTION = "forged";
  const proc = Bun.spawn(["bun", CLI, "_chat-receive-v2"], {
    env,
    stdin: new Response(JSON.stringify(makeChatMessage({ id: randomUUID(), from: makeCli("host-b"), to: managedPeer(machine.rcPrefix, target) }))),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(1);
  expect(loadLedger(machine)).toHaveLength(0);
});

test("reusing the session name with another provider/thread rejects stale mail before append", async () => {
  const { configPath, machine, target } = setup();
  const stale = makeChatMessage({
    id: randomUUID(),
    from: makeCli("host-b"),
    to: managedPeer(machine.rcPrefix, target),
  });
  const replacement = makeSession({ name: target.name, agent: "codex", uuid: randomUUID(), chatEnabled: true });
  writeFileSync(sessionsPath(machine), `${JSON.stringify(replacement)}\n`);
  const result = await receive(configPath, JSON.stringify(stale));
  expect(result.code).toBe(1);
  expect(result.output).toContain("provider mismatch");
  expect(loadLedger(machine)).toHaveLength(0);
});

test("v1/name-only wire shape fails before append", async () => {
  const { configPath, machine } = setup();
  const result = await receive(configPath, JSON.stringify({ id: randomUUID(), from: "peer", to: "worker", body: "x" }));
  expect(result.code).toBe(1);
  expect(result.output).toContain("invalid v2 envelope");
  expect(loadLedger(machine)).toHaveLength(0);
});

test("Desktop-native coordination does not write the managed v2 ledger", () => {
  const { machine } = setup();
  expect(loadLedger(machine)).toHaveLength(0);
  appendMessage(
    machine,
    makeChatMessage({ from: makeCli("host-a"), to: { kind: "owner" }, body: "only ccmux producers write here" }),
  );
  expect(loadLedger(machine)).toHaveLength(1);
});
