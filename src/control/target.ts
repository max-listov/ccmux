import { AppError } from 'stitchkit';
import { findSession, loadSessions } from '../session/registry.ts';
import type { MachineConfig, ManagedPeer, Session } from '../types.ts';

export function controlTarget(m: MachineConfig, target: ManagedPeer): Session {
  const session = findSession(loadSessions(m), target.session);
  if (
    m.rcPrefix !== target.machine ||
    !session ||
    session.uuid !== target.threadId ||
    session.agent !== target.agent
  ) {
    throw new AppError('IDENTITY_MISMATCH', {
      message: 'The exact managed session is unavailable',
      status: 409,
    });
  }
  return session;
}
