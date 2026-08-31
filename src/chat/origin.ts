import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import { stableJson } from '../agent/launchInputs.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import type { MessageAttribution, MessageOrigin, NotificationAudience } from './originSchema.ts';

function refuseOrigin(reason: string): never {
  log.warn({ msg: 'message origin admission refused', reason });
  throw new AppError('ORIGIN_REFUSED', 'Message origin or audience is not authorized', 403);
}

export function principalOrigin(principal: ChatPrincipal): MessageOrigin {
  const runtime = principal.kind === 'managed' || principal.kind === 'codex-app';
  return {
    ingress:
      principal.kind === 'service'
        ? principal.transport === 'local'
          ? 'local-control'
          : 'service'
        : principal.kind,
    actor: runtime ? 'agent' : 'unknown',
    assurance: runtime ? 'runtime-identity' : 'unknown',
    application: null,
  };
}

export function admitMessageOrigin(
  machine: MachineConfig,
  principal: ChatPrincipal,
  attribution: MessageAttribution | undefined,
  notification: NotificationAudience,
): MessageOrigin {
  const origin = principalOrigin(principal);
  if (attribution === undefined) {
    if (notification === 'owner') refuseOrigin('missing-application-binding');
    return origin;
  }
  const binding = machine.messageApplications[attribution.applicationId];
  if (principal.kind !== 'service') refuseOrigin('unsupported-ingress');
  if (!binding) refuseOrigin('unknown-application');
  if (!binding.callers.includes(principal.machine)) refuseOrigin('caller-not-bound');
  if (!binding.channels.includes(attribution.channelId)) refuseOrigin('channel-not-bound');
  if (!binding.actors.includes(attribution.actor)) refuseOrigin('actor-not-allowed');
  if (notification === 'owner' && !binding.ownerNotifications)
    refuseOrigin('owner-notifications-not-allowed');
  return {
    ...origin,
    actor: attribution.actor,
    assurance: 'application-attested',
    application: {
      ...attribution,
      revision: binding.revision,
      digest: createHash('sha256').update(stableJson(binding)).digest('hex'),
    },
  };
}
