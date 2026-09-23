import { z } from 'zod';
import { supportsManagedInput } from '../agent/index.ts';
import { appendAck, loadAcks } from '../chat/ackLog.ts';
import { type RemoteTransport, remoteTransportAncestor } from '../chat/auth.ts';
import { resolveCodexAppPeer } from '../chat/codexApp.ts';
import {
  COMMUNICATION_AUTHORIZATION_HELP,
  readCommunicationAuthorization,
  requireCommunicationAuthorization,
  requireOriginatingBasis,
} from '../chat/communicationAuthorization.ts';
import {
  type CommunicationAuthorization,
  continuationRef,
} from '../chat/communicationAuthorizationSchema.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { isExternalToken, lookupExternal } from '../chat/external.ts';
import {
  codexAppThreadId,
  externalTarget,
  isCodexAppToken,
  managedPeer,
  ownerTarget,
  principalLabel,
  targetLabel,
} from '../chat/identity.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { appendMessage, loadLedger } from '../chat/ledger.ts';
import { localMessageLookup } from '../chat/localMessages.ts';
import { principalOrigin } from '../chat/origin.ts';
import { isRoleToken, resolveRole } from '../chat/roleAddress.ts';
import { OWNER, pendingConditional } from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { routeFor } from '../fleet/address.ts';
import { RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { appendOutbound } from '../fleet/outbox.ts';
import { queuedForRetryNotice, relay, runPeer } from '../fleet/transport.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import type { AgentKind, ChatMessage, ChatTarget, CodexAppPeer, MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { preview } from '../util/preview.ts';
import { parseFlags } from './flags.ts';
import { usageLine } from './help.ts';
import {
  assertExpected,
  localCandidate,
  resolveRemoteCodexAppPeer,
  resolveRemotePeer,
  senderFor,
  warnAboutAnonymousRemote,
} from './messagePeers.ts';
import { msgCancel } from './msgCancel.ts';
import { msgPending } from './msgPending.ts';
import { msgSent } from './msgSent.ts';

/**
 * Name the letter that was just accepted, in the exact form a continuation must reference.
 *
 * `thread-continuation` is the cheapest of the three bases — it repeats no rationale and no quote —
 * and it asks for one thing: a reference to the sender's OWN accepted letter. The recipient reads
 * both ids off the delivered line; the sender was shown neither, so the value the contract demanded
 * had no source on this side. Printed here, it is copied rather than composed: one value, because
 * joining a thread id to a message id by hand is where the wrong pair gets written.
 */
function announceLetter(envelope: ChatMessage): void {
  const ref = continuationRef(envelope);
  if (ref !== null)
    console.log(
      `letter ${ref} — sourceMessageRef of a thread-continuation to this recipient under the same --task`,
    );
}

/** Record one letter to a peer, and say so. */
function sendLetter(
  machine: MachineConfig,
  from: Parameters<typeof buildEnvelope>[0],
  target: Parameters<typeof buildEnvelope>[1],
  body: string,
  options: NonNullable<Parameters<typeof buildEnvelope>[3]>,
  senderTransport: Parameters<typeof warnAboutAnonymousRemote>[1],
): number {
  // Replace-on-task belongs to TIMERS, not to ordinary mail. A re-armed watchdog means "forget the
  // previous alarm"; two letters under one task name do not mean "forget the first one". Waiting
  // for a turn boundary is the default, so keying this on deferral would silently eat a message
  // whose only sin was arriving while the recipient was busy.
  if (options.notBefore != null && options.task != null) {
    const prior = pendingConditional(loadLedger(machine), loadAcks(machine), {
      from,
      to: target,
      task: options.task,
    });
    for (const message of prior) appendAck(machine, message.id, 'cancel', message.to);
  }
  const envelope = buildEnvelope(from, target, body, options);
  appendMessage(machine, envelope);
  warnAboutAnonymousRemote(from, senderTransport);
  log.info({
    msg: 'chat message sent',
    from: principalLabel(from),
    to: targetLabel(target),
    task: options.task,
  });
  console.log(`sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
  announceLetter(envelope);
  return 0;
}

export async function cmdMsg(args: string[], transport?: RemoteTransport | null): Promise<number> {
  const flags = parseFlags('msg', args);
  const positionals = flags.positionals;
  const task = flags.str('task') ?? null;
  // Deferred unless the sender explicitly asks to break in: see `buildEnvelope`.
  const defer = !flags.bool('interrupt');
  const onBehalfOf = flags.str('on-behalf-of') ?? null;
  const afterSec = flags.int('after') ?? null;
  const asJson = flags.bool('json');
  let expectedAgent: AgentKind | null = null;
  const agentFlag = flags.str('to-agent');
  if (agentFlag !== undefined) {
    const parsed = AgentKindSchema.safeParse(agentFlag);
    if (!parsed.success) {
      console.error('msg: --to-agent needs a supported runtime');
      return 1;
    }
    expectedAgent = parsed.data;
  }
  let expectedThread: string | null = null;
  const threadFlag = flags.str('to-thread');
  if (threadFlag !== undefined) {
    const parsed = z.uuid().safeParse(threadFlag);
    if (!parsed.success) {
      console.error('msg: --to-thread needs a UUID');
      return 1;
    }
    expectedThread = parsed.data;
  }
  let communicationAuthorization: CommunicationAuthorization | undefined;
  const authorizationPath = flags.str('communication-authorization');
  if (authorizationPath !== undefined) {
    try {
      communicationAuthorization = await readCommunicationAuthorization(authorizationPath);
    } catch {
      console.error(
        `msg: invalid communication authorization file. ${COMMUNICATION_AUTHORIZATION_HELP}`,
      );
      return 1;
    }
  }

  const machine = loadMachineConfig();
  const sessions = loadSessions(machine);
  const from = await senderFor(machine.rcPrefix, sessions, machine);
  if ('error' in from) {
    console.error(from.error);
    return 1;
  }
  const senderTransport =
    transport === undefined
      ? from.kind === 'cli'
        ? remoteTransportAncestor(machine)
        : null
      : transport;

  if (positionals[0] === 'pending') return msgPending(machine, from, positionals[1]);
  if (positionals[0] === 'sent') return msgSent(machine, from, positionals[1], asJson);
  if (positionals[0] === 'cancel') return msgCancel(machine, from, positionals[1]);

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

  try {
    requireCommunicationAuthorization(from, principalOrigin(from), communicationAuthorization);
  } catch {
    console.error(
      `msg: communicationAuthorization must name its basis. ${COMMUNICATION_AUTHORIZATION_HELP}`,
    );
    return 1;
  }
  // Resolved lazily and once: reading the ledger and outbox costs nothing on the ordinary path where
  // the basis is the user's own instruction, and the same index answers all three target shapes.
  const lookup = localMessageLookup(machine);
  let communicationReceipt: ReturnType<typeof requireOriginatingBasis>;
  const unverifiedBasis = (to: ChatTarget): string | null => {
    try {
      communicationReceipt = requireOriginatingBasis(
        from,
        to,
        communicationAuthorization,
        lookup,
        task,
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
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
    const unverified = unverifiedBasis(resolved);
    if (unverified !== null) {
      console.error(`msg: ${unverified}`);
      return 1;
    }
    const envelope = buildEnvelope(from, resolved, body, {
      task,
      defer,
      onBehalfOf,
      communicationAuthorization,
      communicationReceipt,
    });
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
    // Only an ACCEPTED letter is named. A letter held for retry has an id and a record here, but it
    // is not yet in the recipient's ledger, and a continuation of a correspondence whose opening
    // letter never arrived is exactly the claim this reference must not help anyone make.
    const code = await relay(result, `msg ${targetToken}`);
    if (code === 0) announceLetter(envelope);
    return code;
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
    const unverified = unverifiedBasis(target);
    if (unverified !== null) {
      console.error(`msg: ${unverified}`);
      return 1;
    }
    return sendLetter(
      machine,
      from,
      target,
      body,
      {
        task,
        defer,
        onBehalfOf,
        notBefore,
        communicationAuthorization,
        communicationReceipt,
      },
      senderTransport,
    );
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
  const unverified = unverifiedBasis(target);
  if (unverified !== null) {
    console.error(`msg: ${unverified}`);
    return 1;
  }
  return sendLetter(
    machine,
    from,
    target,
    body,
    {
      task,
      defer,
      onBehalfOf,
      notBefore,
      communicationAuthorization,
      communicationReceipt,
    },
    senderTransport,
  );
}
