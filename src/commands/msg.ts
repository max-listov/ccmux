import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerFor } from "../agent/index.ts";
import { cliPrincipal, managedPeer, ownerTarget, principalLabel, targetLabel } from "../chat/identity.ts";
import { appendAck, appendMessage, appendMessageOnce, loadAckedIds, loadLedger, pendingConditional, OWNER } from "../chat/store.ts";
import { CHAT_CREDENTIAL_ENV, hasChatCredential, hasSshdAncestor } from "../chat/auth.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { CHAT_GENERATION, ChatMessageSchema, ListJsonSchema } from "../config/schema.ts";
import { findSession, loadSessions } from "../config/sessions.ts";
import { routeFor } from "../fleet/address.ts";
import { appendOutbound } from "../fleet/outbox.ts";
import { relay, runRemote } from "../fleet/transport.ts";
import type { AgentKind, ChatMessage, ChatPrincipal, ManagedPeer, Session } from "../types.ts";
import { log } from "../util/log.ts";
import { preview } from "../util/preview.ts";
import { usageLine } from "./help.ts";

const RemoteListSchema = ListJsonSchema.pick({ sessions: true });

function senderFor(machine: string, sessions: Session[]): ChatPrincipal | { error: string } {
  const name = process.env.CCMUX_SESSION;
  if (name === undefined || name === "") return cliPrincipal(machine);
  const session = findSession(sessions, name);
  if (!session || !session.chatEnabled) {
    return { error: `msg: this session '${name}' has chat disabled — enable with: ccmux chat on ${name}` };
  }
  if (!hasChatCredential(loadMachineConfig(), session, process.env[CHAT_CREDENTIAL_ENV])) {
    return { error: `msg: CCMUX_SESSION does not identify the calling process as managed session '${name}'` };
  }
  return managedPeer(machine, session);
}

function assertExpected(target: ManagedPeer, agent: AgentKind | null, threadId: string | null): string | null {
  if (agent !== null && target.agent !== agent) return `provider mismatch: expected ${agent}, found ${target.agent}`;
  if (threadId !== null && target.threadId !== threadId) return `thread mismatch: expected ${threadId}, found ${target.threadId}`;
  return null;
}

async function resolveRemotePeer(alias: string, machine: string, name: string): Promise<ManagedPeer | { error: string }> {
  const result = await runRemote(alias, ["ccmux", "list", "--json"], { timeoutMs: 20_000 });
  if (result.transportFailed) return { error: `msg ${machine}:${name}: transport failed while resolving exact peer` };
  if (result.code !== 0) return { error: `msg ${machine}:${name}: remote peer resolution failed (exit ${result.code})` };
  try {
    const parsed = RemoteListSchema.parse(JSON.parse(result.stdout));
    const matches = parsed.sessions.filter((session) => session.name === name);
    if (matches.length !== 1) {
      const candidates = matches.map((session) => `${session.agent ?? "unknown"}#${session.uuid}`).join(", ");
      const suffix = candidates === "" ? "" : `; candidates: ${candidates}`;
      return { error: `msg ${machine}:${name}: expected one exact peer, found ${matches.length}${suffix}` };
    }
    const match = matches[0];
    if (match === undefined) return { error: `msg ${machine}:${name}: peer disappeared during resolution` };
    return {
      kind: "managed",
      source: "ccmux",
      machine,
      agent: match.agent,
      session: match.name,
      threadId: z.uuid().parse(match.uuid),
    };
  } catch {
    return { error: `msg ${machine}:${name}: remote identity is missing or version-incompatible` };
  }
}

function buildEnvelope(
  from: ChatPrincipal,
  to: ManagedPeer | ReturnType<typeof ownerTarget>,
  body: string,
  task: string | null,
  defer: boolean,
  onBehalfOf: string | null,
  notBefore: string | null,
): ChatMessage {
  return ChatMessageSchema.parse({
    v: CHAT_GENERATION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    from,
    to,
    body,
    task,
    defer,
    onBehalfOf,
    notBefore,
  });
}

/** Transport-only v2 receiver. Old binaries reject the unknown verb before appending anything. */
export async function cmdReceiveChat(transportAuthenticated = hasSshdAncestor(), rawInput?: string): Promise<number> {
  if (process.env.CCMUX_SESSION !== undefined) {
    console.error("chat receive is transport-only");
    return 1;
  }
  if (!transportAuthenticated) {
    console.error("chat receive is only admitted through an authenticated SSH transport");
    return 1;
  }
  let message: ChatMessage;
  try {
    message = ChatMessageSchema.parse(JSON.parse(rawInput ?? await Bun.stdin.text()));
  } catch {
    console.error("chat receive: invalid v2 envelope");
    return 1;
  }
  if (message.to.kind !== "managed") {
    console.error("chat receive: remote owner target is not allowed");
    return 1;
  }
  const machine = loadMachineConfig();
  if (message.to.machine !== machine.rcPrefix) {
    console.error(`chat receive: target machine mismatch (${message.to.machine} != ${machine.rcPrefix})`);
    return 1;
  }
  const session = findSession(loadSessions(machine), message.to.session);
  if (!session) {
    console.error(`chat receive: target session '${message.to.session}' no longer exists`);
    return 1;
  }
  const current = managedPeer(machine.rcPrefix, session);
  const mismatch = assertExpected(current, message.to.agent, message.to.threadId);
  if (mismatch !== null) {
    console.error(`chat receive: ${mismatch}`);
    return 1;
  }
  if (!session.chatEnabled || providerFor(session).chatDeliverable === undefined) {
    console.error(`chat receive: target '${session.name}' cannot receive chat`);
    return 1;
  }
  if (!(await appendMessageOnce(machine, message))) {
    console.log(`already delivered (${message.id}) — retry ignored`);
    return 0;
  }
  console.log(`accepted ${principalLabel(message.from)} → ${targetLabel(message.to)}`);
  return 0;
}

export async function cmdMsg(args: string[]): Promise<number> {
  const positionals: string[] = [];
  let task: string | null = null;
  let defer = false;
  let onBehalfOf: string | null = null;
  let afterSec: number | null = null;
  let expectedAgent: AgentKind | null = null;
  let expectedThread: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--task") task = args[++index] ?? null;
    else if (value === "--defer") defer = true;
    else if (value === "--on-behalf-of") onBehalfOf = args[++index] ?? null;
    else if (value === "--to-agent") {
      const parsed = z.enum(["claude", "codex"]).safeParse(args[++index]);
      if (!parsed.success) return console.error("msg: --to-agent needs claude|codex"), 1;
      expectedAgent = parsed.data;
    } else if (value === "--to-thread") {
      const parsed = z.uuid().safeParse(args[++index]);
      if (!parsed.success) return console.error("msg: --to-thread needs a UUID"), 1;
      expectedThread = parsed.data;
    } else if (value === "--after") {
      const seconds = Number.parseInt(args[++index] ?? "", 10);
      if (!Number.isFinite(seconds) || seconds <= 0) return console.error("msg: --after needs positive seconds"), 1;
      afterSec = seconds;
    } else if (value?.startsWith("--")) return console.error(`msg: unknown flag '${value}'\n${usageLine("msg")}`), 1;
    else if (value !== undefined) positionals.push(value);
  }

  const machine = loadMachineConfig();
  const sessions = loadSessions(machine);
  const from = senderFor(machine.rcPrefix, sessions);
  if ("error" in from) return console.error(from.error), 1;

  if (positionals[0] === "cancel") {
    const cancelTask = positionals[1];
    if (!cancelTask) return console.log("usage: ccmux msg cancel <task>"), 1;
    const pending = pendingConditional(loadLedger(machine), loadAckedIds(machine), { from, task: cancelTask });
    for (const message of pending) appendAck(machine, message.id, "cancel", message.to);
    console.log(`cancelled ${pending.length} undelivered message(s) from ${principalLabel(from)} for task '${cancelTask}'`);
    return 0;
  }

  let targetToken = positionals[0];
  let body = positionals.slice(1).join(" ").trim();
  if (body === "" && targetToken !== undefined && !process.stdin.isTTY) body = (await Bun.stdin.text()).trim();
  if (!targetToken || body === "") return console.error(usageLine("msg")), 1;

  if (onBehalfOf !== null && from.kind === "managed") {
    const sender = findSession(sessions, from.session);
    if (!sender?.promptModules.includes("router")) return console.error("msg: only a router session may use --on-behalf-of"), 1;
  }
  const notBefore = afterSec === null ? null : new Date(Date.now() + afterSec * 1000).toISOString();
  if (afterSec !== null && defer) {
    console.log("msg: note — --after with --defer only arrives at the recipient's next turn boundary; a self-watchdog should use bare --after");
  }
  if (targetToken === OWNER) {
    if (expectedAgent !== null || expectedThread !== null) return console.error("msg: owner has no provider/thread"), 1;
    appendMessage(machine, buildEnvelope(from, ownerTarget(), body, task, defer, onBehalfOf, notBefore));
    console.log(`sent ${principalLabel(from)} → owner: ${preview(body)}`);
    return 0;
  }

  const route = routeFor(targetToken, machine);
  if (route.kind === "error") return console.error(route.message), 1;
  if (route.kind === "remote") {
    if (defer || notBefore !== null) return console.error("msg: --defer/--after are local-only"), 1;
    const resolved = await resolveRemotePeer(route.alias, route.machine, route.session);
    if ("error" in resolved) return console.error(resolved.error), 1;
    const mismatch = assertExpected(resolved, expectedAgent, expectedThread);
    if (mismatch !== null) return console.error(`msg: ${mismatch}`), 1;
    const envelope = buildEnvelope(from, resolved, body, task, false, onBehalfOf, null);
    const result = await runRemote(route.alias, ["ccmux", "_chat-receive-v2"], { stdin: JSON.stringify(envelope), timeoutMs: 20_000 });
    appendOutbound(machine, {
      kind: "msg",
      envelope,
      result: { ok: !result.transportFailed && result.code === 0, detail: result.transportFailed ? "transport failed" : result.code === 0 ? "" : `remote exit ${result.code}` },
    });
    return relay(result, `msg ${targetToken}`);
  }

  targetToken = route.session;
  const session = findSession(sessions, targetToken);
  if (!session) return console.error(`msg: no such session '${targetToken}'`), 1;
  const target = managedPeer(machine.rcPrefix, session);
  const mismatch = assertExpected(target, expectedAgent, expectedThread);
  if (mismatch !== null) return console.error(`msg: ${mismatch}`), 1;
  if (!session.chatEnabled || providerFor(session).chatDeliverable === undefined) {
    return console.error(`msg: recipient '${targetToken}' cannot receive chat`), 1;
  }
  if ((defer || notBefore !== null) && task !== null) {
    const prior = pendingConditional(loadLedger(machine), loadAckedIds(machine), { from, to: target, task });
    for (const message of prior) appendAck(machine, message.id, "cancel", message.to);
  }
  const envelope = buildEnvelope(from, target, body, task, defer, onBehalfOf, notBefore);
  appendMessage(machine, envelope);
  log.info({ msg: "chat message sent", from: principalLabel(from), to: targetLabel(target), task });
  console.log(`sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
  return 0;
}
