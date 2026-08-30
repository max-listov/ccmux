#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";
import { connectOwnedCodex } from "../src/agent/codex/ownedRpc.ts";
import { startCodexAppTurn } from "../src/agent/codex/appServer.ts";
import { codexTextInput } from "../src/agent/codex/turnInput.ts";
import { findOwnedCodexReceipt } from "../src/chat/ownedCodexReceipt.ts";
import { loadLedger } from "../src/chat/store.ts";
import { managedPeer, chatPrincipalKey, chatTargetKey } from "../src/chat/identity.ts";
import { readCodexRuntime } from "../src/agent/codex/ownedRead.ts";
import type { Session } from "../src/types.ts";
import { shellJoin } from "../src/util/shellQuote.ts";

const config = process.argv[2];
if (config === undefined || !basename(dirname(config)).startsWith("ccmux-owned-probe-")) throw new Error("Pass the isolated probe's machine.json");
const root = dirname(config);
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, "utf8")));
if (m.stateDir !== join(root, "state") || m.telegram !== undefined || Object.keys(m.fleet ?? {}).length !== 0) throw new Error("Probe must be isolated, with no Telegram or fleet routes");
const cli = process.argv[3] ?? join(process.cwd(), "src/cli.ts");
const env: Record<string, string> = { CCMUX_CONFIG: config, CCMUX_STATE_DIR: m.stateDir,
  CCMUX_CACHE_DIR: join(root, "cache"), CCMUX_DATA_DIR: join(root, "data") };
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && env[key] === undefined) env[key] = value;
for (const key of ["CCMUX_SESSION", "CCMUX_CHAT_CREDENTIAL", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) delete env[key];
const a = loadSessions(m).find((s) => s.name === "agent-a");
const b = loadSessions(m).find((s) => s.name === "agent-b");
if (a === undefined || b === undefined) throw new Error("Run codex-owned-runtime-probe first");

function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function command(args: string[], timeout = 180_000, expected = 0) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  check(code === expected, `${args[0]} exit ${code}: ${stdout}\n${stderr}`);
  return stdout;
}
async function until(label: string, test: () => boolean, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!test()) { check(Date.now() < deadline, `Timed out: ${label}`); await Bun.sleep(250); }
}
function snapshot(s: Session) {
  const read = readOwnedCodexStatus(m, s);
  return read.status === "live" ? read.snapshot : null;
}
function progress(phase: string, evidence: unknown) { console.log(JSON.stringify({ phase, evidence })); }

// Establish a positive known case before any waiting loop; an empty/broken reader cannot pass.
check(snapshot(a)?.state === "idle" && snapshot(b)?.state === "idle", "Both native sessions must be live and idle before the test");
progress("baseline", [a, b].map((s) => ({ name: s.name, uuid: s.uuid, snapshot: snapshot(s) })));
await Promise.all([command(["wait", a.name, "--timeout", "10"]), command(["wait", b.name, "--timeout", "10"])]);

const token = `native-${crypto.randomUUID()}`;
const invocation = shellJoin([process.execPath, "--no-env-file", cli]);
// Resumed test history can contain older source invocations. Pin this run's artifact explicitly.
const request = `Authorized native runtime communication test ${token}. For this run invoke exactly ${invocation} msg ${m.rcPrefix}:${b.name} --to-agent codex --to-thread ${b.uuid} with this message body: '${token} A_TO_B. Reply once with ${token} B_TO_A using the pinned reply command supplied by ccmux. This is a receipt test; do not message the owner or any other session.' Do not reuse CLI paths from earlier conversation history. When the B_TO_A receipt arrives, finish with RECEIVED and do not send another message. Do not change files or run unrelated work.`;
await command(["msg", a.name, request]);
const peerA = managedPeer(m.rcPrefix, a), peerB = managedPeer(m.rcPrefix, b);
const roundTrip = () => {
  const messages = loadLedger(m).filter((msg) => msg !== null && msg.body.includes(token));
  return messages.some((msg) => msg !== null && chatPrincipalKey(msg.from) === chatPrincipalKey(peerA) && chatTargetKey(msg.to) === chatTargetKey(peerB))
    && messages.some((msg) => msg !== null && chatPrincipalKey(msg.from) === chatPrincipalKey(peerB) && chatTargetKey(msg.to) === chatTargetKey(peerA));
};
await until("A → B → A exact managed identities", roundTrip);
await command(["wait", a.name, "--timeout", "120"]);
await command(["wait", b.name, "--timeout", "120"]);
progress("round-trip", loadLedger(m).filter((msg) => msg !== null && msg.body.includes(token)).map((msg) => msg === null ? null : ({ id: msg.id, from: msg.from, to: msg.to })));

const rpc = await connectOwnedCodex(m, a);
try {
  const busyId = await startCodexAppTurn(rpc, a.uuid, crypto.randomUUID(), codexTextInput("Run the shell command sleep 15, then reply BUSY_TEST_DONE. This is a timing test. Do not message anyone or do other work."));
  await until("native working", () => snapshot(a)?.turn?.id === busyId && snapshot(a)?.state === "working", 15_000);
  await command(["msg", a.name, `Deferred test ${token}: reply DEFERRED_DONE and do not contact anyone.`, "--defer"]);
  await command(["wait", a.name, "--timeout", "2"], 5_000, 2);
  check(snapshot(a)?.turn?.id === busyId, "Deferred message changed a busy turn");
  await command(["wait", a.name, "--timeout", "120"]);
  const deferred = loadLedger(m).find((msg) => msg?.defer && msg.body.includes(token));
  check(deferred !== null && deferred !== undefined, "Deferred ledger record missing");
  const receipt = await findOwnedCodexReceipt(rpc, a.uuid, deferred.id);
  check(receipt?.status === "completed", "Native receipt did not prove deferred completion");
  progress("busy-defer-wait", { busyTurn: busyId, deferredMessage: deferred.id, receipt });
} finally { rpc.close(); }

process.env.CCMUX_CONFIG = config;
process.env.CCMUX_STATE_DIR = m.stateDir;
const cpu = process.cpuUsage(), started = performance.now(), rss = process.memoryUsage().rss;
const reads = await Promise.all(Array.from({ length: 100 }, () => readCodexRuntime({ session: a.name, threadId: a.uuid, timeoutMs: 1000 })));
check(reads.every((read) => read.status === "live" && read.snapshot?.threadId === a.uuid), "Resident concurrency returned missing/wrong identity");
progress("100-concurrent-native-reads", { elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu), rssDelta: process.memoryUsage().rss - rss });
progress("completed-initial-e2e", { config, identityA: a.uuid, identityB: b.uuid });
