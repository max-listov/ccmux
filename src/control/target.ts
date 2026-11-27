import { findSession, loadSessions } from '../session/registry.ts';
import type { MachineConfig, ManagedPeer, Session } from '../types.ts';
import { refusals } from './schema/refusals.ts';

export function controlTarget(m: MachineConfig, target: ManagedPeer): Session {
  const session = findSession(loadSessions(m), target.session);
  if (
    m.rcPrefix !== target.machine ||
    !session ||
    session.uuid !== target.threadId ||
    session.agent !== target.agent
  ) {
    throw refusals.errors.IDENTITY_MISMATCH({
      message: 'The exact managed session is unavailable',
    });
  }
  return session;
}
