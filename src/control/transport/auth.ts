import { AppError } from 'stitchkit';
import { setRequestDimensions } from 'stitchkit/observability';
import { createAuthHook } from 'stitchkit/server';
import { hasChatCredential } from '../../chat/auth.ts';
import { chatPrincipalKey, managedPeer, servicePrincipal } from '../../chat/identity.ts';
import { ChatPrincipalSchema } from '../../chat/identitySchema.ts';
import { chatEnabledFor } from '../../config/chat.ts';
import { findSession, loadSessions } from '../../session/registry.ts';
import type { ChatPrincipal, MachineConfig } from '../../types.ts';
import { CCMUX_CONTROL_CALLER_HEADER, ControlTransportCallerSchema } from './boundary.ts';

/** The socket authenticates the local OS user; a managed claim additionally needs its capability. */
export function controlPrincipal(m: MachineConfig, headers: Headers): ChatPrincipal {
  const sessionName = headers.get('x-ccmux-session');
  const credential = headers.get('authorization');
  const transportCaller = headers.get(CCMUX_CONTROL_CALLER_HEADER);
  if (transportCaller !== null) {
    if (sessionName !== null || credential !== null)
      throw new AppError('UNAUTHORIZED', 'Conflicting local caller credentials', 401);
    const parsed = ControlTransportCallerSchema.safeParse(transportCaller);
    if (!parsed.success) throw new AppError('UNAUTHORIZED', 'Invalid local transport caller', 401);
    return servicePrincipal(parsed.data, 'declared-service');
  }
  if (sessionName === null && credential === null) return servicePrincipal(m.rcPrefix, 'local');
  if (sessionName === null || credential === null || !credential.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Invalid managed caller credentials', 401);
  }
  const session = findSession(loadSessions(m), sessionName);
  if (
    !session ||
    !chatEnabledFor(session, m) ||
    !hasChatCredential(m, session, credential.slice(7))
  ) {
    throw new AppError('UNAUTHORIZED', 'Invalid managed caller credentials', 401);
  }
  return managedPeer(m.rcPrefix, session);
}

export function controlAuth(m: MachineConfig) {
  return createAuthHook<ChatPrincipal>({
    resolve: async (ctx) => {
      if (!ctx.req) throw new AppError('UNAUTHORIZED', 'Local request required', 401);
      return controlPrincipal(m, ctx.req.headers);
    },
    resolveFromContext: async (ctx) => ChatPrincipalSchema.parse(ctx.principal),
    rules: { local: 'authenticated' },
    inject: (ctx, principal) => {
      ctx.principal = principal;
      // Carried to the request log: a failure nobody can attribute is a failure nobody can fix —
      // 314 catalog timeouts were recorded with no way to say who kept asking.
      if (principal !== null) setRequestDimensions({ caller: chatPrincipalKey(principal) });
    },
  });
}
