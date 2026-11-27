import { serviceCaller } from '@stitchwire/client';
import { OperationEffectSchema } from 'stitchkit/contract';
import { setRequestDimensions } from 'stitchkit/observability';
import { createAuthHook } from 'stitchkit/server';
import { hasChatCredential } from '../../chat/auth.ts';
import { chatPrincipalKey, managedPeer, servicePrincipal } from '../../chat/identity.ts';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import { chatEnabledFor } from '../../config/chat.ts';
import { findSession, loadSessions } from '../../session/registry.ts';
import type { ChatPrincipal, MachineConfig } from '../../types.ts';
import { refusals } from '../schema/refusals.ts';
import { ControlTransportCallerSchema } from './boundary.ts';

/** The socket authenticates the local OS user; a managed claim additionally needs its capability. */
export function controlPrincipal(m: MachineConfig, headers: Headers): ChatPrincipal {
  const sessionName = headers.get('x-stitchmux-session');
  const credential = headers.get('authorization');
  if (sessionName === null && credential === null) return servicePrincipal(m.rcPrefix, 'local');
  if (sessionName === null || credential === null || !credential.startsWith('Bearer ')) {
    throw refusals.errors.UNAUTHORIZED({ message: 'Invalid managed caller credentials' });
  }
  const session = findSession(loadSessions(m), sessionName);
  if (
    !session ||
    !chatEnabledFor(session, m) ||
    !hasChatCredential(m, session, credential.slice(7))
  ) {
    throw refusals.errors.UNAUTHORIZED({ message: 'Invalid managed caller credentials' });
  }
  return managedPeer(m.rcPrefix, session);
}

/**
 * A caller of the declared service reaches the control operations — each declares its effect in
 * `effect`, the same word a transport's descriptor is projected from —
 * and nothing else on this socket: not the contract identity, the event streams or the peer reads,
 * whatever a transport forwards.
 */
export function refuseOutsideService(principal: unknown, effect: unknown): void {
  const parsed = ChatPrincipalSchema.safeParse(principal);
  if (!parsed.success) return;
  const caller = parsed.data;
  if (caller.kind !== 'service' || caller.transport !== 'declared-service') return;
  if (OperationEffectSchema.safeParse(effect).success) return;
  throw refusals.errors.FORBIDDEN({
    message: 'This operation is not part of the declared service',
  });
}

export function controlAuth(m: MachineConfig) {
  return createAuthHook<ChatPrincipal>({
    resolve: async (ctx) => {
      if (!ctx.req) throw refusals.errors.UNAUTHORIZED({ message: 'Local request required' });
      const caller = serviceCaller(ctx);
      return caller
        ? servicePrincipal(ControlTransportCallerSchema.parse(caller.caller), 'declared-service')
        : controlPrincipal(m, ctx.req.headers);
    },
    resolveFromContext: async (ctx) => ChatPrincipalSchema.parse(ctx.principal),
    // `public` is the scope of the contract identity the framework mounts; on this socket it is
    // asked by the same local caller as everything else, and answered on the same terms.
    rules: { local: 'authenticated', public: 'authenticated' },
    inject: (ctx, principal) => {
      ctx.principal = principal;
      // Carried to the request log: a failure nobody can attribute is a failure nobody can fix —
      // 314 catalog timeouts were recorded with no way to say who kept asking.
      if (principal !== null) setRequestDimensions({ caller: chatPrincipalKey(principal) });
    },
  });
}
