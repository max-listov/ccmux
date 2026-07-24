import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { appendMessage, loadAckedIds } from "../src/chat/store.ts";
import type { ChatMessage } from "../src/types.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function setup(chatEnabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-hook-"));
  const sessionsFile = join(dir, ".ccmux-sessions");
  const cfg = { claudeBin: "/bin/claude", tmuxBin: "/bin/tmux", projectsDir: "/p", rcPrefix: "test", sessionsFile, bootLabel: "b" };
  const cfgPath = join(dir, "machine.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(sessionsFile, `${JSON.stringify({ name: "worker", dir: "/tmp/w", uuid: randomUUID(), chatEnabled })}\n`);
  return { cfgPath, m: MachineConfigSchema.parse(cfg) };
}

function deferMsg(to: string, body: string, defer = true): ChatMessage {
  return { id: randomUUID(), ts: new Date().toISOString(), from: "cli", to, body, task: null, defer, onBehalfOf: null, notBefore: null };
}

async function runHook(cfgPath: string, session: string | undefined): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) env.CCMUX_SESSION = session;
  else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(["bun", CLI, "stop-hook"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

test("drains a deferred message → {decision:block,reason}; records an ack; second run is empty", async () => {
  const { cfgPath, m } = setup(true);
  appendMessage(m, deferMsg("worker", "do the thing"));

  const out1 = await runHook(cfgPath, "worker");
  const parsed: unknown = JSON.parse(out1);
  expect(parsed).toMatchObject({ decision: "block" });
  expect(out1).toContain("do the thing");
  expect(out1).toContain("[chat from cli]"); // shared peer-framing tag
  expect(loadAckedIds(m).size).toBe(1);

  const out2 = await runHook(cfgPath, "worker"); // already acked → clean stop
  expect(out2).toBe("");
});

test("no output when the session has chat disabled", async () => {
  const { cfgPath, m } = setup(false);
  appendMessage(m, deferMsg("worker", "ignored"));
  expect(await runHook(cfgPath, "worker")).toBe("");
});

test("no output when CCMUX_SESSION is unset (not a managed session)", async () => {
  const { cfgPath, m } = setup(true);
  appendMessage(m, deferMsg("worker", "ignored"));
  expect(await runHook(cfgPath, undefined)).toBe("");
});

test("a NON-deferred message is not drained by the hook (daemon delivers those)", async () => {
  const { cfgPath, m } = setup(true);
  appendMessage(m, deferMsg("worker", "peer ping", false));
  expect(await runHook(cfgPath, "worker")).toBe("");
  expect(loadAckedIds(m).size).toBe(0);
});
