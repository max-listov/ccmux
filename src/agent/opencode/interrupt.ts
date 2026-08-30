import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../runtime/interrupt.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { OpenCodeProjection } from './projection.ts';
import type { OpenCodeClient } from './server.ts';

/** The existing owner executes cancellation; no permission reply or second native writer. */
export async function applyOpenCodeInterrupt(
  m: MachineConfig,
  session: Session,
  client: OpenCodeClient,
  projection: OpenCodeProjection,
  signal: AbortSignal,
): Promise<void> {
  const command = readRuntimeInterrupt(m, session);
  if (command?.phase !== 'queued') return;
  const valid = () => isCancellableTurn(projection.snapshot(), command.generation, command.turnId);
  if (!valid() || !session.nativeSession) {
    await writeRuntimeInterrupt(m, session, { ...command, phase: 'rejected' });
    return;
  }
  await writeRuntimeInterrupt(m, session, { ...command, phase: 'uncertain' });
  // Persistence yields to native events. Settlement in that interval must not abort another turn.
  if (!valid()) {
    await writeRuntimeInterrupt(m, session, { ...command, phase: 'rejected' });
    return;
  }
  signal.throwIfAborted();
  await client.session.abort({ sessionID: session.nativeSession.id }, { signal });
  await writeRuntimeInterrupt(m, session, { ...command, phase: 'accepted' });
}
