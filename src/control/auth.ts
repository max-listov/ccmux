import { AppError } from 'stitchkit';
import { createAuthHook } from 'stitchkit/server';
import { hasChatCredential } from '../chat/auth.ts';
import { cliPrincipal, managedPeer } from '../chat/identity.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { ChatPrincipalSchema } from '../config/schema.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';

/** The socket authenticates the local OS user; a managed claim additionally needs its capability. */
export function controlPrincipal(m: MachineConfig, headers: Headers): ChatPrincipal {
  const sessionName = headers.get('x-ccmux-session');
  const credential = headers.get('authorization');
  if (sessionName === null && credential === null) return cliPrincipal(m.rcPrefix);
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
    },
  });
}
