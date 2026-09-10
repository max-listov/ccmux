import { z } from 'zod';
import { supportsManagedInput } from '../agent/index.ts';
import { type RemoteTransport, remoteTransportAncestor } from '../chat/auth.ts';
import { resolveCodexAppPeer } from '../chat/codexApp.ts';
import {
  COMMUNICATION_AUTHORIZATION_HELP,
  readCommunicationAuthorization,
  requireCommunicationAuthorization,
  requireOriginatingBasis,
} from '../chat/communicationAuthorization.ts';
import type { CommunicationAuthorization } from '../chat/communicationAuthorizationSchema.ts';
import { buildEnvelope } from '../chat/compose.ts';
import { isExternalToken, lookupExternal } from '../chat/external.ts';
import {
  chatTargetKey,
  codexAppThreadId,
  externalTarget,
  isCodexAppToken,
  managedPeer,
  ownerTarget,
  principalLabel,
  sameSender,
  targetLabel,
} from '../chat/identity.ts';
import { localMessageLookup } from '../chat/localMessages.ts';
import { principalOrigin } from '../chat/origin.ts';
import { isRoleToken, resolveRole } from '../chat/roleAddress.ts';
import {
  appendAck,
  appendMessage,
  deliverableTargets,
  loadAckedIds,
  loadCursors,
  loadLedger,
  OWNER,
  pendingConditional,
  pendingImmediate,
} from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { AgentKindSchema } from '../config/schema.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { promptInvocation } from '../env.ts';
import { routeFor } from '../fleet/address.ts';
import { RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { appendOutbound, loadOutbox } from '../fleet/outbox.ts';
import { queuedForRetryNotice, relay, runPeer } from '../fleet/transport.ts';
import type { AgentKind, ChatTarget, CodexAppPeer } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { log } from '../util/log.ts';
import { preview } from '../util/preview.ts';

import { usageLine } from './help.ts';
import {
  assertExpected,
  localCandidate,
  resolveRemoteCodexAppPeer,
  resolveRemotePeer,
  senderFor,
  warnAboutAnonymousRemote,
} from './messagePeers.ts';

export async function cmdMsg(args: string[], transport?: RemoteTransport | null): Promise<number> {
  const positionals: string[] = [];
  let task: string | null = null;
  // Deferred unless the sender explicitly asks to break in: see `buildEnvelope`.
  let defer = true;
  let onBehalfOf: string | null = null;
  let afterSec: number | null = null;
  let expectedAgent: AgentKind | null = null;
  let expectedThread: string | null = null;
  let communicationAuthorization: CommunicationAuthorization | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--communication-authorization') {
      const path = args[++index];
      if (!path || communicationAuthorization !== undefined) {
        console.error('msg: --communication-authorization needs one JSON file');
        return 1;
      }
      try {
        communicationAuthorization = await readCommunicationAuthorization(path);
      } catch {
        console.error(
          `msg: invalid communication authorization file. ${COMMUNICATION_AUTHORIZATION_HELP}`,
        );
        return 1;
      }
    } else if (value === '--task') task = args[++index] ?? null;
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
    transport === undefined
      ? from.kind === 'cli'
        ? remoteTransportAncestor(machine)
        : null
      : transport;

  // What is waiting, before anyone asks what to withdraw. Without it the queue could only be acted
  // on blindly: `cancel` was the only way to learn anything about outstanding mail, and it answered
  // with a number that meant four different things.
  if (positionals[0] === 'pending') {
    const wanted = positionals[1];
    const ledger = loadLedger(machine);
    const live = deliverableTargets(machine);
    const waiting = [
      ...pendingConditional(
        ledger,
        loadAckedIds(machine),
        wanted === undefined ? { live } : { task: wanted, live },
      ).map((msg) => ({
        msg,
        kind: msg.notBefore !== null ? 'timer' : 'deferred',
      })),
      ...pendingImmediate(
        ledger,
        loadCursors(machine),
        wanted === undefined ? { live } : { task: wanted, live },
      ).map((msg) => ({
        msg,
        kind: 'immediate',
      })),
    ].sort((left, right) => left.msg.ts.localeCompare(right.msg.ts));
    // Counted separately and never mixed into the queue: a letter whose recipient was removed is
    // not waiting, but it is not nothing either — somebody wrote it and nobody will ever read it.
    // Folding it into "waiting" said a colleague was owed an answer; dropping it silently would
    // hide that a letter was lost. It is history now, and history is what the ledger keeps.
    const stranded = [
      ...pendingConditional(
        ledger,
        loadAckedIds(machine),
        wanted === undefined ? {} : { task: wanted },
      ),
      ...pendingImmediate(
        ledger,
        loadCursors(machine),
        wanted === undefined ? {} : { task: wanted },
      ),
    ].filter((msg) => msg.to.kind === 'managed' && !live.has(chatTargetKey(msg.to))).length;
    const strandedLine =
      stranded === 0
        ? null
        : `${stranded} letter(s) can never be delivered — the session they were addressed to no longer exists`;
    if (waiting.length === 0) {
      console.log(
        wanted === undefined
          ? 'nothing is waiting: every message in this machine’s ledger has been handed over'
          : `nothing is waiting for task '${wanted}'`,
      );
      if (strandedLine !== null) console.log(strandedLine);
      return 0;
    }
    const now = Date.now();
    const rows = waiting.map(({ msg, kind }) => [
      humanizeDuration((now - Date.parse(msg.ts)) / 1000),
      kind,
      principalLabel(msg.from),
      targetLabel(msg.to),
      msg.task ?? '-',
      preview(msg.body),
    ]);
    // Widths come from the rows, because these are addresses: a fixed column that fits the header
    // splits every real one, and a reader who has to reassemble an address by eye is the reason the
    // wrong session gets written to.
    const header = ['AGE', 'KIND', 'FROM', 'TO', 'TASK', 'TEXT'];
    const width = header.map((label, column) =>
      Math.max(label.length, ...rows.map((row) => (row[column] ?? '').length)),
    );
    for (const row of [header, ...rows])
      console.log(
        row
          .map((cell, column) =>
            column === row.length - 1 ? cell : cell.padEnd(width[column] ?? 0),
          )
          .join('  ')
          .trimEnd(),
      );
    // A letter cannot be withdrawn by a stranger, and after a restart the sender's own new life used
    // to be one. It no longer is — but a letter from ANOTHER session still is, and saying so here is
    // what keeps the reader from concluding the queue is stuck.
    const mine = waiting.filter(({ msg }) => sameSender(msg.from, from)).length;
    if (mine < waiting.length)
      console.log(
        `${waiting.length - mine} of these were sent by another session; only their own sender can retract them`,
      );
    if (strandedLine !== null) console.log(strandedLine);
    return 0;
  }

  if (positionals[0] === 'cancel') {
    const cancelTask = positionals[1];
    if (!cancelTask) {
      console.log('usage: ccmux msg cancel <task>');
      return 1;
    }
    const ledger = loadLedger(machine);
    const acked = loadAckedIds(machine);
    const pending = pendingConditional(ledger, acked, {
      from,
      task: cancelTask,
    });
    for (const message of pending) appendAck(machine, message.id, 'cancel', message.to);
    if (pending.length > 0)
      console.log(
        `cancelled ${pending.length} undelivered message(s) from ${principalLabel(from)} for task '${cancelTask}'`,
      );
    else {
      // Zero used to be the whole answer, and it covered four different states at once: nothing of
      // mine is waiting, someone else's is, the task name is a typo, and — before `sameSender` —
      // "the life of this session that sent it is gone". Each needs a different next move, so each
      // is said.
      const others = pendingConditional(ledger, acked, { task: cancelTask });
      // The outbox counts as knowing the name. Without it a task whose only letters went to another
      // machine was announced as a typo — one line above the line saying where those letters went.
      const known =
        ledger.some((slot) => slot?.task === cancelTask) ||
        loadOutbox(machine).some((record) => record.envelope.task === cancelTask);
      if (others.length > 0) {
        const senders = [...new Set(others.map((msg) => principalLabel(msg.from)))].join(', ');
        console.log(
          `nothing of yours is waiting for '${cancelTask}': ${others.length} message(s) under that task belong to ${senders}, and only their own sender can retract them`,
        );
      } else if (known) {
        console.log(
          `nothing to cancel for '${cancelTask}': every message under that task has been delivered or already retracted`,
        );
      } else {
        console.log(
          `no task '${cancelTask}' in this machine’s ledger — check the name, or run ${promptInvocation()} msg pending to see what is waiting`,
        );
      }
    }
    const carried = pendingImmediate(ledger, loadCursors(machine), { from, task: cancelTask });
    if (carried.length > 0) {
      console.log(
        `${carried.length} immediate message(s) for '${cancelTask}' are still on their way — immediate mail has no withdrawal, it is handed over at the recipient's next opportunity`,
      );
    }
    // Cancel is local-only, exactly as `--after` is, and for the same reason: a letter to another
    // machine lives in THAT machine's ledger, so there is nothing here to tombstone. Saying it is
    // the whole point — "cancelled 0" is otherwise read as "nothing of mine is waiting", which is
    // the opposite of the truth for the one kind of mail a sender cannot see from here.
    const away = loadOutbox(machine).filter(
      (record) =>
        record.envelope.task === cancelTask &&
        sameSender(record.envelope.from, from) &&
        (record.envelope.to.kind === 'managed' || record.envelope.to.kind === 'codex-app') &&
        record.envelope.to.machine !== machine.rcPrefix,
    );
    if (away.length > 0) {
      console.log(
        `${away.length} message(s) for '${cancelTask}' went to another machine — cancel is local-only and cannot withdraw them there`,
      );
    }
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
    const unverified = unverifiedBasis(target);
    if (unverified !== null) {
      console.error(`msg: ${unverified}`);
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
    const envelope = buildEnvelope(from, target, body, {
      task,
      defer,
      onBehalfOf,
      notBefore,
      communicationAuthorization,
      communicationReceipt,
    });
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
  const unverified = unverifiedBasis(target);
  if (unverified !== null) {
    console.error(`msg: ${unverified}`);
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
  const envelope = buildEnvelope(from, target, body, {
    task,
    defer,
    onBehalfOf,
    notBefore,
    communicationAuthorization,
    communicationReceipt,
  });
  appendMessage(machine, envelope);
  warnAboutAnonymousRemote(from, senderTransport);
  log.info({ msg: 'chat message sent', from: principalLabel(from), to: targetLabel(target), task });
  console.log(`sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`);
  return 0;
}
