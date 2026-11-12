import { z } from 'zod';
import { supportsManagedInput } from '../agent/index.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { routeFor } from '../fleet/address.ts';
import { appendOutboxAck, RETRY_WINDOW_MS } from '../fleet/flush.ts';
import { appendOutbound } from '../fleet/outbox.ts';
import { queuedForRetryNotice, remoteFailureCause, runPeer } from '../fleet/transport.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import type {
  ChatMessage,
  ChatPrincipal,
  ChatTarget,
  CodexAppPeer,
  MachineConfig,
} from '../types.ts';
import { log } from '../util/log.ts';
import { preview } from '../util/preview.ts';
import { appendAck, loadAcks } from './ackLog.ts';
import type { RemoteTransport } from './auth.ts';
import { resolveCodexAppPeer } from './codexApp.ts';
import {
  COMMUNICATION_AUTHORIZATION_HELP,
  requireCommunicationAuthorization,
  requireOriginatingBasis,
} from './communicationAuthorization.ts';
import { continuationRef } from './communicationAuthorizationSchema.ts';
import { buildEnvelope } from './compose.ts';
import { isExternalToken, lookupExternal } from './external.ts';
import {
  codexAppThreadId,
  externalTarget,
  isCodexAppToken,
  managedPeer,
  ownerTarget,
  principalLabel,
  targetLabel,
} from './identity.ts';
import { appendMessage, loadLedger } from './ledger.ts';
import {
  anonymousRemoteWarning,
  assertExpected,
  localCandidate,
  REMOTE_HOP_MS,
  resolveRemoteCodexAppPeer,
  resolveRemotePeer,
} from './letterParties.ts';
import type { LetterRequest } from './letterRequestSchema.ts';
import { localMessageLookup } from './localMessages.ts';
import { principalOrigin } from './origin.ts';
import { isRoleToken, resolveRole } from './roleAddress.ts';
import { type SendReceipt, type SentLetterState, sentLetter } from './sentLetterSchema.ts';
import { OWNER, pendingConditional } from './store.ts';

/**
 * What became of the letter, said once for each reader.
 *
 * `refused`: nothing was written; `reason` is the whole sentence. Otherwise the letter exists and
 * `receipt` is its answer. The rest is for a person: `aside` beside the answer, `told` as the answer
 * itself, `remarks` for stderr (the far machine's own words and warnings). `continuation` is the
 * reference a continuation of this correspondence must cite — only for a letter that was accepted.
 */
export type LetterOutcome =
  | { status: 'refused'; reason: string }
  | {
      status: 'sent';
      receipt: SendReceipt;
      exitCode: number;
      aside: string[];
      told: string[];
      remarks: string[];
      continuation: string | null;
    };

export interface LetterOptions {
  /** How the calling process reached this machine, when it is a remote command line. */
  senderTransport?: RemoteTransport | null;
  run?: typeof runPeer;
  /**
   * When the caller stops waiting (epoch ms). The hops to another machine share what is left of it,
   * each at most `REMOTE_HOP_MS`; without it each hop has its own. An operation answers inside its
   * transport's budget, so it passes one; a command line waits for each hop.
   */
  deadline?: number;
}

export async function sendLetter(
  m: MachineConfig,
  from: ChatPrincipal,
  request: LetterRequest,
  options: LetterOptions = {},
): Promise<LetterOutcome> {
  const run = options.run ?? runPeer;
  const hop = () =>
    options.deadline === undefined
      ? REMOTE_HOP_MS
      : Math.max(1, Math.min(REMOTE_HOP_MS, options.deadline - Date.now()));
  const { task, onBehalfOf, toAgent, toThread, communicationAuthorization } = request;
  const body = request.body.trim();
  if (body === '') return refused('the letter is empty');
  // Deferred unless the sender explicitly asks to break in: see `buildEnvelope`.
  const defer = !request.interrupt;
  const sessions = loadSessions(m);
  const aside: string[] = [];
  const remarks: string[] = [];
  const warning = anonymousRemoteWarning(from, options.senderTransport ?? null);
  const warned = () => {
    if (warning !== null) remarks.push(warning);
  };

  if (onBehalfOf !== null && from.kind === 'managed') {
    const sender = findSession(sessions, from.session);
    if (!sender?.promptModules.includes('router'))
      return refused('only a router session may use --on-behalf-of');
  }
  const notBefore =
    request.afterSeconds === null
      ? null
      : new Date(Date.now() + request.afterSeconds * 1000).toISOString();
  if (notBefore !== null && !defer)
    aside.push(
      'msg: note — --after with --interrupt fires into whatever the recipient is doing when it comes due',
    );

  const sent = (
    envelope: ChatMessage,
    state: SentLetterState,
    told: string[],
    note: string | null = null,
    exitCode = 0,
  ): LetterOutcome => ({
    status: 'sent',
    receipt: {
      ...sentLetter(envelope, state),
      from: principalLabel(from),
      notBefore: envelope.notBefore,
      note,
    },
    exitCode,
    aside,
    told,
    remarks,
    continuation: state === 'accepted' ? continuationRef(envelope) : null,
  });

  let token = request.to;
  if (token === OWNER) {
    if (toAgent !== null || toThread !== null) return refused('owner has no provider/thread');
    // The owner has no turn to wait for, so the default deferral is meaningless here.
    const envelope = buildEnvelope(from, ownerTarget(), body, {
      task,
      defer: false,
      onBehalfOf,
      notBefore,
    });
    appendMessage(m, envelope);
    warned();
    return sent(envelope, 'accepted', [`sent ${principalLabel(from)} → owner: ${preview(body)}`]);
  }

  if (isExternalToken(token)) {
    if (toAgent !== null || toThread !== null)
      return refused('an owner outside the fleet has no provider/thread');
    if (notBefore !== null)
      return refused(
        '--after waits for a turn boundary; there is no turn on the other side of a human',
      );
    const external = lookupExternal(m, token);
    if ('error' in external) return refused(external.error);
    const target = externalTarget(external.name);
    const envelope = buildEnvelope(from, target, body, {
      task,
      defer: false,
      onBehalfOf,
      notBefore: null,
    });
    appendMessage(m, envelope);
    warned();
    // Refused, and the route is NAMED. A half-success here would be the worst answer available: the
    // sender would believe it had reached the owner, which is the exact failure this address exists
    // to remove.
    const where = [
      `ccmux does not deliver there — ${external.where}. It is mirrored to the owner, who carries it.`,
      `It stays outstanding until an answer is recorded: ccmux relay ${targetLabel(target)}${task === null ? '' : ` --task ${task}`} "<their answer>"`,
    ];
    return sent(
      envelope,
      'recorded',
      [`recorded ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`, ...where],
      where.join(' '),
    );
  }

  try {
    requireCommunicationAuthorization(from, principalOrigin(from), communicationAuthorization);
  } catch {
    return refused(
      `communicationAuthorization must name its basis. ${COMMUNICATION_AUTHORIZATION_HELP}`,
    );
  }
  // Resolved lazily and once: reading the ledger and outbox costs nothing on the ordinary path where
  // the basis is the user's own instruction, and the same index answers all three target shapes.
  const lookup = localMessageLookup(m);
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
  const route = routeFor(token, m);
  if (route.kind === 'error') return { status: 'refused', reason: route.message };
  if (route.kind === 'remote') {
    // A delay is timed against THIS machine's clock and delivered by THIS machine's daemon, neither
    // of which owns the recipient. Waiting for a turn boundary is different: it travels in the
    // envelope and the peer's own daemon applies it, which is why only the delay is refused.
    if (notBefore !== null) return refused('--after is local-only');
    const resolved = isCodexAppToken(route.session)
      ? await resolveRemoteCodexAppPeer(m, route.alias, route.machine, route.session, run, hop())
      : await resolveRemotePeer(m, route.alias, route.machine, route.session, run, hop());
    if ('error' in resolved) return { status: 'refused', reason: resolved.error };
    const mismatch = assertExpected(resolved, toAgent, toThread);
    if (mismatch !== null) return refused(mismatch);
    const unverified = unverifiedBasis(resolved);
    if (unverified !== null) return refused(unverified);
    const envelope = buildEnvelope(from, resolved, body, {
      task,
      defer,
      onBehalfOf,
      communicationAuthorization,
      communicationReceipt,
    });
    const result = await run(m, route.machine, route.alias, ['ccmux', '_chat-receive-v2'], {
      stdin: JSON.stringify(envelope),
      timeoutMs: hop(),
    });
    appendOutbound(m, {
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
    warned();
    // Not "nothing was sent": the envelope is already in the outbox above, and saying otherwise is
    // what sent two sessions chasing a transport problem the supervisor was already handling.
    if (result.transportFailed) {
      const notice = queuedForRetryNotice(
        `msg ${request.to}`,
        result.failureDetail ?? null,
        RETRY_WINDOW_MS / 60_000,
        result.permanent === true,
        result.delivery,
      );
      // A refusal that will refuse identically is settled here, so a look back says the same
      // thing this receipt does; anything else is kept and retried.
      if (result.permanent === true) appendOutboxAck(m, envelope.id, 'refused');
      return sent(envelope, result.permanent === true ? 'refused' : 'held', [notice], notice);
    }
    // The far side's own words are for a person: its complaints still reach one, and its refusal
    // is the note of the receipt. Not accepted, and kept: the outbox tries a letter again for as
    // long as its window.
    if (result.stderr !== '') remarks.push(result.stderr.trimEnd());
    const refusal = remoteFailureCause(result.stderr) ?? remoteFailureCause(result.stdout);
    return sent(
      envelope,
      result.code === 0 ? 'accepted' : 'held',
      result.stdout.split('\n').filter((line) => line !== ''),
      result.code === 0
        ? null
        : (refusal ?? `the recipient's machine answered exit ${result.code}`),
      result.code,
    );
  }

  token = route.session;
  let target: Exclude<ChatTarget, { kind: 'owner' | 'external' }>;
  if (isCodexAppToken(token)) {
    const parsed = z.uuid().safeParse(codexAppThreadId(token));
    if (!parsed.success) return refused('app address needs a thread UUID');
    let app: CodexAppPeer;
    try {
      app = await resolveCodexAppPeer(m, parsed.data);
    } catch (error) {
      return refused(
        `App thread unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    target = app;
  } else {
    if (isRoleToken(token)) {
      const resolved = resolveRole(
        token,
        sessions.map((s) => localCandidate(s, m)),
      );
      if ('error' in resolved) return refused(resolved.error);
      token = resolved.name;
    }
    const session = findSession(sessions, token);
    if (!session) return refused(`no such session '${token}'`);
    target = managedPeer(m.rcPrefix, session);
    const mismatch = assertExpected(target, toAgent, toThread);
    if (mismatch !== null) return refused(mismatch);
    if (!chatEnabledFor(session, m) || !supportsManagedInput(session))
      return refused(`recipient '${token}' cannot receive chat`);
  }
  if (target.kind === 'codex-app') {
    const mismatch = assertExpected(target, toAgent, toThread);
    if (mismatch !== null) return refused(mismatch);
  }
  const unverified = unverifiedBasis(target);
  if (unverified !== null) return refused(unverified);

  // Replace-on-task belongs to TIMERS, not to ordinary mail. A re-armed watchdog means "forget the
  // previous alarm"; two letters under one task name do not mean "forget the first one". Waiting
  // for a turn boundary is the default, so keying this on deferral would silently eat a message
  // whose only sin was arriving while the recipient was busy.
  if (notBefore !== null && task !== null) {
    const prior = pendingConditional(loadLedger(m), loadAcks(m), { from, to: target, task });
    for (const message of prior) appendAck(m, message.id, 'cancel', message.to);
  }
  const envelope = buildEnvelope(from, target, body, {
    task,
    defer,
    onBehalfOf,
    notBefore,
    communicationAuthorization,
    communicationReceipt,
  });
  appendMessage(m, envelope);
  warned();
  log.info({ msg: 'chat message sent', from: principalLabel(from), to: targetLabel(target), task });
  return sent(envelope, 'accepted', [
    `sent ${principalLabel(from)} → ${targetLabel(target)}: ${preview(body)}`,
  ]);
}

const refused = (reason: string): LetterOutcome => ({
  status: 'refused',
  reason: `msg: ${reason}`,
});
