import { AppError } from 'stitchkit';
import { setRequestDimensions } from 'stitchkit/observability';
import { createAuthHook } from 'stitchkit/server';
import { hasChatCredential } from '../../chat/auth.ts';
import { chatPrincipalKey, managedPeer, servicePrincipal } from '../../chat/identity.ts';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import { chatEnabledFor } from '../../config/chat.ts';
import { findSession, loadSessions } from '../../session/registry.ts';
import type { ChatPrincipal, MachineConfig } from '../../types.ts';
import { ServiceEffectSchema } from '../schema/serviceEffect.ts';
import { CCMUX_CONTROL_CALLER_HEADER, ControlTransportCallerSchema } from './boundary.ts';

/** The socket authenticates the local OS user; a managed claim additionally needs its capability. */
export function controlPrincipal(m: MachineConfig, headers: Headers): ChatPrincipal {
  const sessionName = headers.get('x-ccmux-session');
  const credential = headers.get('authorization');
  const transportCaller = headers.get(CCMUX_CONTROL_CALLER_HEADER);
  if (transportCaller !== null) {
    if (sessionName !== null || credential !== null)
      throw new AppError('UNAUTHORIZED', {
        message: 'Conflicting local caller credentials',
        status: 401,
      });
    const parsed = ControlTransportCallerSchema.safeParse(transportCaller);
    if (!parsed.success)
      throw new AppError('UNAUTHORIZED', {
        message: 'Invalid local transport caller',
        status: 401,
      });
    return servicePrincipal(parsed.data, 'declared-service');
  }
  if (sessionName === null && credential === null) return servicePrincipal(m.rcPrefix, 'local');
  if (sessionName === null || credential === null || !credential.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', {
      message: 'Invalid managed caller credentials',
      status: 401,
    });
  }
  const session = findSession(loadSessions(m), sessionName);
  if (
    !session ||
    !chatEnabledFor(session, m) ||
    !hasChatCredential(m, session, credential.slice(7))
  ) {
    throw new AppError('UNAUTHORIZED', {
      message: 'Invalid managed caller credentials',
      status: 401,
    });
  }
  return managedPeer(m.rcPrefix, session);
}

/**
 * A caller of the declared service reaches the control operations — each declares its effect in
 * `meta.service` (`serviceEffect.ts`), the same word a transport's descriptor is projected from —
 * and nothing else on this socket: not the contract identity, the event streams or the peer reads,
 * whatever a transport forwards.
 */
export function refuseOutsideService(principal: unknown, meta: unknown): void {
  const parsed = ChatPrincipalSchema.safeParse(principal);
  if (!parsed.success) return;
  const caller = parsed.data;
  if (caller.kind !== 'service' || caller.transport !== 'declared-service') return;
  const effect = ServiceEffectSchema.safeParse(
    typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'service') : undefined,
  );
  if (effect.success) return;
  throw new AppError('FORBIDDEN', {
    message: 'This operation is not part of the declared service',
    status: 403,
  });
}

export function controlAuth(m: MachineConfig) {
  return createAuthHook<ChatPrincipal>({
    resolve: async (ctx) => {
      if (!ctx.req)
        throw new AppError('UNAUTHORIZED', { message: 'Local request required', status: 401 });
      return controlPrincipal(m, ctx.req.headers);
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
