import { z } from 'zod';
import { lastTranscriptMessage, supportsManagedInput } from '../agent/index.ts';
import type { RemoteTransport } from '../chat/auth.ts';
import {
  CHAT_CREDENTIAL_ENV,
  hasChatCredential,
  hasSshdAncestor,
  remoteTransportAncestor,
} from '../chat/auth.ts';
import { currentCodexAppThreadId, resolveCodexAppPeer } from '../chat/codexApp.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { isExternalToken, lookupExternal } from '../chat/external.ts';
import {
  cliPrincipal,
  codexAppThreadId,
  externalTarget,
  isCodexAppToken,
  managedPeer,
  ownerTarget,
  principalLabel,
  targetLabel,
} from '../chat/identity.ts';
import { isRoleToken, type RoleCandidate, resolveRole } from '../chat/roleAddress.ts';
import {
  appendAck,
  appendMessage,
  appendMessageOnce,
  loadAckedIds,
  loadLedger,
  OWNER,
  pendingConditional,
} from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { AgentKindSchema, ChatMessageSchema, ListJsonSchema } from '../config/schema.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { routeFor } from '../fleet/address.ts';
import { RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { appendOutbound } from '../fleet/outbox.ts';
import { queuedForRetryNotice, relay, runPeer } from '../fleet/transport.ts';
import type {
  AgentKind,
  ChatMessage,
  ChatPrincipal,
  CodexAppPeer,
  MachineConfig,
  ManagedPeer,
  Session,
} from '../types.ts';
import { log } from '../util/log.ts';
import { preview } from '../util/preview.ts';
import { usageLine } from './help.ts';

const RemoteListSchema = ListJsonSchema.pick({ sessions: true });

export function anonymousRemoteWarning(
  from: ChatPrincipal,
  transport: RemoteTransport | null,
): string | null {
  if (from.kind !== 'cli' || transport === null) return null;
  const transportLabel = transport === 'ssh' ? 'ssh' : 'stitchwire';
  return (
    `msg: warning — this command is running under ${transportLabel} without a managed sender; sent as ${principalLabel(from)}, ` +
    'so the recipient cannot reply to the originating agent. Run ccmux msg <machine>:<session> from the managed ' +
    `session instead of invoking remote ccmux msg through ${transportLabel}.`
  );
}

function warnAboutAnonymousRemote(from: ChatPrincipal, transport: RemoteTransport | null): void {
  const warning = anonymousRemoteWarning(from, transport);
  if (warning !== null) console.error(warning);
}

async function senderFor(
  machine: string,
  sessions: Session[],
  m: MachineConfig,
): Promise<ChatPrincipal | { error: string }> {
  const name = process.env.CCMUX_SESSION;
  if (name !== undefined && name !== '') {
    const session = findSession(sessions, name);
    if (!session || !chatEnabledFor(session, m)) {
      return {
        error: `msg: this session '${name}' has chat disabled — enable with: ccmux chat on ${name}`,
      };
    }
    if (!hasChatCredential(loadMachineConfig(), session, process.env[CHAT_CREDENTIAL_ENV])) {
      return {
        error: `msg: CCMUX_SESSION does not identify the calling process as managed session '${name}'`,
      };
    }
    return managedPeer(machine, session);
  }
  const appThreadId = currentCodexAppThreadId();
  if (appThreadId !== null) {
    try {
      return await resolveCodexAppPeer(m, appThreadId);
    } catch (error) {
      return {
        error: `msg: Codex App sender identity could not be verified (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  return cliPrincipal(machine);
}

function assertExpected(
  target: ManagedPeer | CodexAppPeer,
  agent: AgentKind | null,
  threadId: string | null,
): string | null {
  if (agent !== null && target.agent !== agent)
    return `provider mismatch: expected ${agent}, found ${target.agent}`;
  if (threadId !== null && target.threadId !== threadId)
    return `thread mismatch: expected ${threadId}, found ${target.threadId}`;
  return null;
}

async function resolveRemoteCodexAppPeer(
  cfg: MachineConfig,
  alias: string | null,
  machine: string,
  token: string,
): Promise<CodexAppPeer | { error: string }> {
  const parsed = z.uuid().safeParse(codexAppThreadId(token));
  if (!parsed.success) return { error: `msg ${machine}:${token}: app address needs a thread UUID` };
  const result = await runPeer(cfg, machine, alias, ['ccmux', '_codex-app-resolve', parsed.data], {
    timeoutMs: 20_000,
  });
  if (result.transportFailed)
    return {
      error: `msg ${machine}:${token}: transport failed while resolving exact App thread${result.failureDetail === undefined ? '' : ` (${result.failureDetail})`}`,
    };
  if (result.code !== 0)
    return { error: `msg ${machine}:${token}: App thread resolution failed (exit ${result.code})` };
  try {
    const peer = z
      .object({
        kind: z.literal('codex-app'),
        source: z.literal('codex-app'),
        machine: z.literal(machine),
        agent: z.literal('codex'),
        threadId: z.literal(parsed.data),
        name: z.string().nullable(),
      })
      .strict()
      .parse(JSON.parse(result.stdout));
    return peer;
  } catch {
    return {
      error: `msg ${machine}:${token}: remote App identity is missing or version-incompatible`,
    };
  }
}

export async function cmdResolveCodexApp(args: string[]): Promise<number> {
  const parsed = z.uuid().safeParse(args[0]);
  if (!parsed.success) {
    console.error('codex app resolve: thread UUID required');
    return 1;
  }
  try {
    console.log(JSON.stringify(await resolveCodexAppPeer(loadMachineConfig(), parsed.data)));
    return 0;
  } catch (error) {
    console.error(`codex app resolve: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function resolveRemotePeer(
  cfg: MachineConfig,
  alias: string | null,
  machine: string,
  token: string,
): Promise<ManagedPeer | { error: string }> {
  const name = token;
  const result = await runPeer(cfg, machine, alias, ['ccmux', 'list', '--json'], {
    timeoutMs: 20_000,
  });
  if (result.transportFailed)
    return {
      error: `msg ${machine}:${name}: transport failed while resolving exact peer${result.failureDetail === undefined ? '' : ` (${result.failureDetail})`}`,
    };
  if (result.code !== 0)
    return { error: `msg ${machine}:${name}: remote peer resolution failed (exit ${result.code})` };
  try {
    const parsed = RemoteListSchema.parse(JSON.parse(result.stdout));
    // A role is resolved on the SAME answer the peer identity comes from, so a session cannot be
    // selected by a role it held one call ago. A peer too old to report roles simply declares none,
    // and the refusal says so rather than guessing.
    let wanted = name;
    if (isRoleToken(name)) {
      const resolved = resolveRole(name, parsed.sessions.map(remoteCandidate), `${machine}:`);
      if ('error' in resolved) return { error: `msg ${machine}:${name}: ${resolved.error}` };
      wanted = resolved.name;
    }
    const matches = parsed.sessions.filter((session) => session.name === wanted);
    if (matches.length !== 1) {
      const candidates = matches
        .map((session) => `${session.agent ?? 'unknown'}#${session.uuid}`)
        .join(', ');
      const suffix = candidates === '' ? '' : `; candidates: ${candidates}`;
      return {
        error: `msg ${machine}:${name}: expected one exact peer, found ${matches.length}${suffix}`,
      };
    }
    const match = matches[0];
    if (match === undefined)
      return { error: `msg ${machine}:${name}: peer disappeared during resolution` };
    return {
      kind: 'managed',
      source: 'ccmux',
      machine,
      agent: match.agent,
      session: match.name,
      threadId: z.uuid().parse(match.uuid),
    };
  } catch {
    return { error: `msg ${machine}:${name}: remote identity is missing or version-incompatible` };
  }
}

/** One remote session, as a role lookup needs to see it. `lastMessage.text` is what tells two
 *  sessions of one project apart — the same thing a person reads before choosing by hand. */
function remoteCandidate(s: z.infer<typeof RemoteListSchema>['sessions'][number]): RoleCandidate {
  return { name: s.name, role: s.role, dir: s.dir, lastText: s.lastMessage?.text ?? null };
}

function localCandidate(s: Session, m: MachineConfig): RoleCandidate {
  return {
    name: s.name,
    role: s.role ?? null,
    dir: s.dir,
    lastText: lastTranscriptMessage(s, m)?.text ?? null,
  };
}

/** Transport-only v2 receiver. Old binaries reject the unknown verb before appending anything. */
export async function cmdReceiveChat(
  transportAuthenticated = hasSshdAncestor(),
  rawInput?: string,
): Promise<number> {
  if (process.env.CCMUX_SESSION !== undefined) {
    console.error('chat receive is transport-only');
    return 1;
  }
  if (!transportAuthenticated) {
    console.error(
      'chat receive is only admitted from an authenticated remote transport — sshd, or the local stitchwire agent',
    );
    return 1;
  }
  let message: ChatMessage;
  try {
    message = ChatMessageSchema.parse(JSON.parse(rawInput ?? (await Bun.stdin.text())));
  } catch {
    console.error('chat receive: invalid v2 envelope');
    return 1;
  }
  if (message.to.kind !== 'managed' && message.to.kind !== 'codex-app') {
    console.error('chat receive: remote owner target is not allowed');
    return 1;
  }
  const machine = loadMachineConfig();
  if (message.to.machine !== machine.rcPrefix) {
    console.error(
      `chat receive: target machine mismatch (${message.to.machine} != ${machine.rcPrefix})`,
    );
    return 1;
  }
  if (message.to.kind === 'managed') {
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
    if (!chatEnabledFor(session, machine) || !supportsManagedInput(session)) {
      console.error(`chat receive: target '${session.name}' cannot receive chat`);
      return 1;
    }
  } else {
    try {
      const current = await resolveCodexAppPeer(machine, message.to.threadId);
      const mismatch = assertExpected(current, message.to.agent, message.to.threadId);
      if (mismatch !== null) {
        console.error(`chat receive: ${mismatch}`);
        return 1;
      }
    } catch (error) {
      console.error(
        `chat receive: App thread unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return 1;
    }
  }
  if (!(await appendMessageOnce(machine, message))) {
    console.log(`already delivered (${message.id}) — retry ignored`);
    return 0;
  }
  console.log(`accepted ${principalLabel(message.from)} → ${targetLabel(message.to)}`);
  return 0;
}

export async function cmdMsg(args: string[], transport?: RemoteTransport | null): Promise<number> {
  const positionals: string[] = [];
  let task: string | null = null;
  // Deferred unless the sender explicitly asks to break in: see `buildEnvelope`.
  let defer = true;
  let onBehalfOf: string | null = null;
  let afterSec: number | null = null;
  let expectedAgent: AgentKind | null = null;
  let expectedThread: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--task') task = args[++index] ?? null;
    else if (value === '--interrupt') defer = false;
    else if (value === '--on-behalf-of') onBehalfOf = args[++index] ?? null;
    else if (value === '--to-agent') {
      const parsed = AgentKindSchema.safeParse(args[++index]);
      if (!parsed.success) {
        console.error('msg: --to-agent needs a supported runtime');
        return 1;
      }
      expectedAgent = parsed.data;
    } else if (value === '--to-thread') {
      const parsed = z.uuid().safeParse(args[++index]);
      if (!parsed.success) {
        console.error('msg: --to-thread needs a UUID');
        return 1;
      }
      expectedThread = parsed.data;
    } else if (value === '--after') {
      const seconds = Number.parseInt(args[++index] ?? '', 10);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        console.error('msg: --after needs positive seconds');
        return 1;
      }
      afterSec = seconds;
    } else if (value?.startsWith('--')) {
      console.error(`msg: unknown flag '${value}'\n${usageLine('msg')}`);
      return 1;
    } else if (value !== undefined) positionals.push(value);
  }

  const machine = loadMachineConfig();
  const sessions = loadSessions(machine);
  const from = await senderFor(machine.rcPrefix, sessions, machine);
  if ('error' in from) {
    console.error(from.error);
    return 1;
  }
  const senderTransport =
    transport === undefined ? (from.kind === 'cli' ? remoteTransportAncestor() : null) : transport;

  if (positionals[0] === 'cancel') {
    const cancelTask = positionals[1];
    if (!cancelTask) {
      console.log('usage: ccmux msg cancel <task>');
      return 1;
    }
    const pending = pendingConditional(loadLedger(machine), loadAckedIds(machine), {
      from,
      task: cancelTask,
    });
    for (const message of pending) appendAck(machine, message.id, 'cancel', message.to);
    console.log(
      `cancelled ${pending.length} undelivered message(s) from ${principalLabel(from)} for task '${cancelTask}'`,
    );
    return 0;
  }

  let targetToken = positionals[0];
  let body = positionals.slice(1).join(' ').trim();
  if (body === '' && targetToken !== undefined && !process.stdin.isTTY)
    body = (await Bun.stdin.text()).trim();
  if (!targetToken || body === '') {
    console.error(usageLine('msg'));
    return 1;
  }

  if (onBehalfOf !== null && from.kind === 'managed') {
    const sender = findSession(sessions, from.session);
    if (!sender?.promptModules.includes('router')) {
      console.error('msg: only a router session may use --on-behalf-of');
      return 1;
    }
  }
  const notBefore = afterSec === null ? null : new Date(Date.now() + afterSec * 1000).toISOString();
  if (afterSec !== null && !defer) {
    console.log(
      'msg: note — --after with --interrupt fires into whatever the recipient is doing when it comes due',
    );
  }
  if (targetToken === OWNER) {
    if (expectedAgent !== null || expectedThread !== null) {
      console.error('msg: owner has no provider/thread');
      return 1;
    }
    appendMessage(
      machine,
      // The owner has no turn to wait for, so the default deferral is meaningless here.
      buildEnvelope(from, ownerTarget(), body, { task, defer: false, onBehalfOf, notBefore }),
    );
    warnAboutAnonymousRemote(from, senderTransport);
    console.log(`sent ${principalLabel(from)} → owner: ${preview(body)}`);
    return 0;
  }

  if (isExternalToken(targetToken)) {
    if (expectedAgent !== null || expectedThread !== null) {
      console.error('msg: an owner outside the fleet has no provider/thread');
      return 1;
    }
    if (notBefore !== null) {
      console.error(
        'msg: --after waits for a turn boundary; there is no turn on the other side of a human',
      );
      return 1;
    }
    const external = lookupExternal(machine, targetToken);
    if ('error' in external) {
      console.error(`msg: ${external.error}`);
      return 1;
    }
    const target = externalTarget(external.name);
    appendMessage(
      machine,
      buildEnvelope(from, target, body, { task, defer: false, onBehalfOf, notBefore: null }),
    );
    warnAboutAnonymousRemote(from, senderTransport);
    // Refused, and the route is NAMED. A half-success here would be the worst answer available: the
    // sender would believe it had reached the owner, which is the exact failure this address exists
    // to remove.
    console.log(`recorded ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
    console.log(
      `ccmux does not deliver there — ${external.where}. It is mirrored to the owner, who carries it.`,
    );
    console.log(
      `It stays outstanding until an answer is recorded: ccmux relay ${targetLabel(target)}${task === null ? '' : ` --task ${task}`} "<their answer>"`,
    );
    return 0;
  }

  const route = routeFor(targetToken, machine);
  if (route.kind === 'error') {
    console.error(route.message);
    return 1;
  }
  if (route.kind === 'remote') {
    // A delay is timed against THIS machine's clock and delivered by THIS machine's daemon, neither
    // of which owns the recipient. Waiting for a turn boundary is different: it travels in the
    // envelope and the peer's own daemon applies it, which is why only the delay is refused.
    if (notBefore !== null) {
      console.error('msg: --after is local-only');
      return 1;
    }
    const resolved = isCodexAppToken(route.session)
      ? await resolveRemoteCodexAppPeer(machine, route.alias, route.machine, route.session)
      : await resolveRemotePeer(machine, route.alias, route.machine, route.session);
    if ('error' in resolved) {
      console.error(resolved.error);
      return 1;
    }
    const mismatch = assertExpected(resolved, expectedAgent, expectedThread);
    if (mismatch !== null) {
      console.error(`msg: ${mismatch}`);
      return 1;
    }
    const envelope = buildEnvelope(from, resolved, body, { task, defer, onBehalfOf });
    const result = await runPeer(
      machine,
      route.machine,
      route.alias,
      ['ccmux', '_chat-receive-v2'],
      { stdin: JSON.stringify(envelope), timeoutMs: 20_000 },
    );
    appendOutbound(machine, {
      kind: 'msg',
      envelope,
      result: {
        ok: !result.transportFailed && result.code === 0,
        detail: result.transportFailed
          ? 'transport failed'
          : result.code === 0
            ? ''
            : `remote exit ${result.code}`,
      },
    });
    warnAboutAnonymousRemote(from, senderTransport);
    // NOT `relay`: the envelope is already in the outbox above, so "nothing was sent" would be a
    // lie, and a lie that costs — it is what sent two sessions chasing a transport problem that the
    // supervisor was already handling, and then to the owner with it.
    if (result.transportFailed) {
      console.log(
        queuedForRetryNotice(
          `msg ${targetToken}`,
          result.failureDetail ?? null,
          RETRY_WINDOW_MS / 60_000,
          result.permanent === true,
          result.delivery,
        ),
      );
      return 0;
    }
    return await relay(result, `msg ${targetToken}`);
  }

  targetToken = route.session;
  if (isCodexAppToken(targetToken)) {
    const parsed = z.uuid().safeParse(codexAppThreadId(targetToken));
    if (!parsed.success) {
      console.error('msg: app address needs a thread UUID');
      return 1;
    }
    let target: CodexAppPeer;
    try {
      target = await resolveCodexAppPeer(machine, parsed.data);
    } catch (error) {
      console.error(
        `msg: App thread unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return 1;
    }
    const mismatch = assertExpected(target, expectedAgent, expectedThread);
    if (mismatch !== null) {
      console.error(`msg: ${mismatch}`);
      return 1;
    }
    // Replace-on-task belongs to TIMERS, not to ordinary mail. A re-armed watchdog means "forget the
    // previous alarm"; two letters under one task name do not mean "forget the first one". Now that
    // waiting for a turn boundary is the default, keying this on deferral would silently eat a
    // message whose only sin was arriving while the recipient was busy.
    if (notBefore !== null && task !== null) {
      const prior = pendingConditional(loadLedger(machine), loadAckedIds(machine), {
        from,
        to: target,
        task,
      });
      for (const message of prior) appendAck(machine, message.id, 'cancel', message.to);
    }
    const envelope = buildEnvelope(from, target, body, { task, defer, onBehalfOf, notBefore });
    appendMessage(machine, envelope);
    warnAboutAnonymousRemote(from, senderTransport);
    log.info({
      msg: 'chat message sent',
      from: principalLabel(from),
      to: targetLabel(target),
      task,
    });
    console.log(`sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
    return 0;
  }
  if (isRoleToken(targetToken)) {
    const resolved = resolveRole(
      targetToken,
      sessions.map((s) => localCandidate(s, machine)),
    );
    if ('error' in resolved) {
      console.error(`msg: ${resolved.error}`);
      return 1;
    }
    targetToken = resolved.name;
  }
  const session = findSession(sessions, targetToken);
  if (!session) {
    console.error(`msg: no such session '${targetToken}'`);
    return 1;
  }
  const target = managedPeer(machine.rcPrefix, session);
  const mismatch = assertExpected(target, expectedAgent, expectedThread);
  if (mismatch !== null) {
    console.error(`msg: ${mismatch}`);
    return 1;
  }
  if (!chatEnabledFor(session, machine) || !supportsManagedInput(session)) {
    console.error(`msg: recipient '${targetToken}' cannot receive chat`);
    return 1;
  }
  if ((defer || notBefore !== null) && task !== null) {
    const prior = pendingConditional(loadLedger(machine), loadAckedIds(machine), {
      from,
      to: target,
      task,
    });
    for (const message of prior) appendAck(machine, message.id, 'cancel', message.to);
  }
  const envelope = buildEnvelope(from, target, body, { task, defer, onBehalfOf, notBefore });
  appendMessage(machine, envelope);
  warnAboutAnonymousRemote(from, senderTransport);
  log.info({ msg: 'chat message sent', from: principalLabel(from), to: targetLabel(target), task });
  console.log(`sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
  return 0;
}
