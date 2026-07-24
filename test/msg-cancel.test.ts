import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadLedger, loadAckedIds, pendingConditional } from "../src/chat/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// Two chat-enabled router sessions (each may relay / arm watchdogs) + a worker target.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ccmux-cancel-"));
  const sessionsFile = join(dir, ".ccmux-sessions");
  const cfg = { claudeBin: "/bin/claude", tmuxBin: "/bin/tmux", projectsDir: "/p", rcPrefix: "test", sessionsFile, bootLabel: "b" };
  const cfgPath = join(dir, "machine.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const row = (name: string, extra: object) =>
    JSON.stringify({ name, dir: "/tmp/x", uuid: randomUUID(), chatEnabled: true, ...extra });
  writeFileSync(
    sessionsFile,
    `${row("router", { promptModules: ["router"] })}\n${row("router2", { promptModules: ["router"] })}\n${row("worker", {})}\n`,
  );
  return { cfgPath, m: MachineConfigSchema.parse(cfg) };
}

async function runMsg(cfgPath: string, session: string | undefined, args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) env.CCMUX_SESSION = session;
  else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(["bun", CLI, "msg", ...args], { env, stdin: stdin !== undefined ? new Response(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

test("msg cancel <task> tombstones this sender's undelivered mail for that task", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "--task", "t1", "watchdog"]);
  // one pending conditional before cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: "t1" }).length).toBe(1);
  const { code, out } = await runMsg(cfgPath, "router", ["cancel", "t1"]);
  expect(code).toBe(0);
  expect(out).toContain("cancelled 1");
  // gone from pending; the ledger message still exists but is now acked-as-cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: "t1" }).length).toBe(0);
});

test("re-arming --after with the same (from,to,task) REPLACES the prior pending — no duplicate watchdog", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "--task", "t2", "arm 1"]);
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "--task", "t2", "arm 2"]);
  const pend = pendingConditional(loadLedger(m), loadAckedIds(m), { task: "t2" });
  expect(pend.length).toBe(1); // only the latest survives
  expect(pend[0]?.body).toBe("arm 2");
  // the ledger holds both; the first was tombstoned
  expect(loadLedger(m).filter((x) => x.task === "t2").length).toBe(2);
});

test("cancel is scoped to the sender — one router can't cancel another's watchdog", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "--task", "shared", "mine"]);
  const { out } = await runMsg(cfgPath, "router2", ["cancel", "shared"]); // different sender
  expect(out).toContain("cancelled 0");
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: "shared" }).length).toBe(1); // untouched
});

test("cancel with no task → usage, exit 1", async () => {
  const { cfgPath } = setup();
  const { code, out } = await runMsg(cfgPath, "router", ["cancel"]);
  expect(code).toBe(1);
  expect(out).toContain("usage: ccmux msg cancel");
});

test("dedup replace only fires with a --task — same target, no task, keeps both pending", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "no-task a"]);
  await runMsg(cfgPath, "router", ["worker", "--after", "600", "no-task b"]);
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { to: "worker" }).length).toBe(2);
});

test("--after + --defer prints the trap note but still sends", async () => {
  const { cfgPath, m } = setup();
  const { code, out } = await runMsg(cfgPath, "router", ["worker", "--after", "600", "--defer", "--task", "t3", "both"]);
  expect(code).toBe(0);
  expect(out).toContain("--after with --defer");
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: "t3" }).length).toBe(1);
});

test("stdin body: echo … | ccmux msg <to> reads the piped text", async () => {
  const { cfgPath, m } = setup();
  const { code } = await runMsg(cfgPath, "router", ["worker"], "piped body here");
  expect(code).toBe(0);
  expect(loadLedger(m).at(-1)?.body).toBe("piped body here");
});
