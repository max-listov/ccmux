#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";
import { connectOwnedCodex } from "../src/agent/codex/ownedRpc.ts";
import { startCodexAppTurn } from "../src/agent/codex/appServer.ts";
import { findOwnedCodexReceipt } from "../src/chat/ownedCodexReceipt.ts";
import { loadLedger, loadCursors } from "../src/chat/store.ts";
import { managedPeer, managedPeerKey } from "../src/chat/identity.ts";
import { capturePaneStyled, sendKeysNamed, sendKeysLiteral } from "../src/tmux/tmux.ts";
import { inspectNativeCodexInput } from "../src/agent/codex/pane.ts";

const config = process.argv[2];
if (config === undefined || !basename(dirname(config)).startsWith("ccmux-owned-probe-")) throw new Error("Pass the isolated probe's machine.json");
const root = dirname(config), cli = process.argv[3] ?? join(process.cwd(), "src/cli.ts");
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, "utf8")));
if (m.stateDir !== join(root, "state") || m.telegram !== undefined || Object.keys(m.fleet ?? {}).length) throw new Error("Probe is not isolated");
const session = loadSessions(m).find((s) => s.name === "agent-a");
if (session === undefined) throw new Error("Missing probe session");
const env: Record<string, string> = { CCMUX_CONFIG: config, CCMUX_STATE_DIR: m.stateDir, CCMUX_CACHE_DIR: join(root, "cache") };
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && env[key] === undefined) env[key] = value;
for (const key of ["CCMUX_SESSION", "CCMUX_CHAT_CREDENTIAL", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) delete env[key];
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
const current = () => readOwnedCodexStatus(m, session).snapshot;
const key = managedPeerKey(managedPeer(m.rcPrefix, session));
async function command(args: string[], expected = 0, timeout = 150_000) {
  const p = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeout);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer); check(code === expected, `${args[0]}: exit ${code}; ${out} ${err}`); return out;
}
async function until(label: string, test: () => boolean, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (!test()) { check(Date.now() < end, `Timed out: ${label}`); await Bun.sleep(200); }
}
function progress(phase: string, evidence: unknown) { console.log(JSON.stringify({ phase, evidence })); }
check(current()?.state === "idle", "Known positive baseline must be live idle");
check(inspectNativeCodexInput(await capturePaneStyled(m, session.name, 40)).state === "deliverable", "Composer must start empty");
await command(["wait", session.name, "--timeout", "10"]);

const token = `safety-${crypto.randomUUID()}`;
const before = current()?.turn?.id;
await sendKeysLiteral(m, session.name, "UNSENT_NATIVE_PROBE");
await Bun.sleep(300);
check(inspectNativeCodexInput(await capturePaneStyled(m, session.name, 40)).state === "input-busy", "Real partial input not observed");
await command(["msg", session.name, `${token} partial gate: reply PARTIAL_DONE only. Do not message anyone.`]);
await command(["wait", session.name, "--timeout", "2"], 2);
check(current()?.turn?.id === before, "Partial input was submitted/overwritten");
check(loadCursors(m).pickups[key] === undefined, "Partial gate claimed pickup");
await sendKeysNamed(m, session.name, "C-u");
await command(["wait", session.name, "--timeout", "120"]);
progress("partial-input", { preserved: true, completedAfterClear: true, threadId: session.uuid });

let rpc = await connectOwnedCodex(m, session);
try {
  const approvalTurn = await startCodexAppTurn(rpc, session.uuid, crypto.randomUUID(),
    "This is an authorized approval-boundary test. Request permission to run the harmless command printf APPROVAL_TEST with sandbox_permissions=require_escalated and justification=approval boundary test. Do not use a non-escalated alternative; wait for the actual approval response. Do not modify files or message anyone.");
  await until("actual native approval", () => current()?.state === "waiting-approval");
  await command(["msg", session.name, `${token} approval gate: reply APPROVAL_GATE_DONE only. Do not message anyone.`, "--defer"]);
  await command(["wait", session.name, "--timeout", "2"], 2);
  check(current()?.turn?.id === approvalTurn && current()?.state === "waiting-approval", "Approval was bypassed");
  check(loadCursors(m).pickups[key] === undefined, "Approval gate claimed pickup");
  await sendKeysNamed(m, session.name, "Escape"); // deny, never auto-approve
  await command(["wait", session.name, "--timeout", "120"]);
  progress("approval-fail-closed", { approvalTurn, denied: true, subsequentMessageCompleted: true });

  const interrupted = await startCodexAppTurn(rpc, session.uuid, crypto.randomUUID(),
    "Run sleep 30, then reply INTERRUPTION_TEST_DONE. Do not contact anyone or change files.");
  await until("real active turn before interruption", () => current()?.turn?.id === interrupted && current()?.state === "working");
  await rpc.request("turn/interrupt", { threadId: session.uuid, turnId: interrupted });
  const settled = await command(["wait", session.name, "--timeout", "30"]);
  check(settled.includes("interrupted"), "Interrupted turn reported as completed");
  await command(["msg", session.name, `${token} after interruption: reply INTERRUPT_RECOVERED only.`]);
  await command(["wait", session.name, "--timeout", "120"]);
  const last = loadLedger(m).find((msg) => msg?.body.includes(`${token} after interruption`));
  check(last, "Missing recovery message");
  check((await findOwnedCodexReceipt(rpc, session.uuid, last.id))?.status === "completed", "Interrupted pickup did not recover");
  progress("interrupted-pickup", { interrupted, settled: settled.trim(), recovered: last.id });

  const beforeRestart = current(); check(beforeRestart !== null, "Missing restart baseline");
  rpc.close();
  await command(["restart", session.name]);
  await until("same UUID, new provider after restart", () => {
    const next = current(); return next !== null && next.providerPid !== beforeRestart.providerPid && next.generation !== beforeRestart.generation && next.state === "idle";
  });
  check(loadSessions(m).find((s) => s.name === session.name)?.uuid === session.uuid, "Restart changed identity");
  rpc = await connectOwnedCodex(m, session);
  const resumed = z.object({ thread: z.object({ id: z.uuid() }), model: z.string() }).parse(await rpc.request("thread/resume", { threadId: session.uuid, excludeTurns: true }));
  check(resumed.thread.id === session.uuid, "Provider resumed a different identity");
  progress("restart-resume", { threadId: session.uuid, beforePid: beforeRestart.providerPid, afterPid: current()?.providerPid });

  const response = z.object({ turn: z.object({ id: z.string() }) }).parse(await rpc.request("turn/start", {
    threadId: session.uuid, clientUserMessageId: crypto.randomUUID(),
    collaborationMode: { mode: "plan", settings: { model: resumed.model, reasoning_effort: "low", developer_instructions: null } },
    input: [{ type: "text", text: "Use request_user_input to ask me to choose Red or Blue. This is a user-input boundary test. Do not decide for me or do other work.", text_elements: [] }],
  }));
  await until("actual native input wait", () => current()?.state === "waiting-input");
  await command(["msg", session.name, `${token} input gate: reply INPUT_GATE_DONE only.`, "--defer"]);
  await command(["wait", session.name, "--timeout", "2"], 2);
  check(current()?.turn?.id === response.turn.id && current()?.state === "waiting-input", "Input request was bypassed");
  await rpc.request("turn/interrupt", { threadId: session.uuid, turnId: response.turn.id });
  await command(["wait", session.name, "--timeout", "120"]);
  progress("input-fail-closed", { waitingTurn: response.turn.id, cancelled: true, completedAfterCancellation: true });
} finally { rpc.close(); }
progress("completed-safety-e2e", { threadId: session.uuid, config });
