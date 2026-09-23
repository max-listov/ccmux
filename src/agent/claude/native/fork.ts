import { admitNativeFork } from '../../../context/fork.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import type { AgentSdk } from './sdk.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Take on the conversation a fork produced, exactly once, and return the session pointing at it.
 *
 * The admission ledger — not this function — is what makes it once: a fork whose acknowledgement was
 * lost must never be dispatched twice, because the second one silently duplicates a conversation.
 * The runtime chooses the new id, so the destination's pinned identity is replaced by it.
 */
export async function adoptNativeFork(
  m: MachineConfig,
  session: Session,
  sdk: AgentSdk,
): Promise<Session> {
  if (!sdk.forkSession) throw new Error('This runtime build cannot fork a conversation');
  const forkSession = sdk.forkSession;
  const result = await admitNativeFork(
    m,
    session,
    {
      fork: (source) =>
        // A branch point must be a TRANSCRIPT message uuid. A turn id here is the runtime's own
        // message id or a mailbox id this project minted, and neither is one — passing it made
        // the runtime refuse the fork outright. Anything else means the whole conversation, which
        // is what a fork with no chosen point is.
        forkSession(
          source.nativeId,
          source.turnId !== null && UUID.test(source.turnId)
            ? { upToMessageId: source.turnId }
            : {},
        ),
      identity: (response) => response.sessionId,
      // Already accepted: the conversation exists and its id is the answer, so nothing is asked
      // of the runtime a second time.
      resume: async (nativeId) => ({ sessionId: nativeId }),
    },
    AbortSignal.timeout(60_000),
  );
  return {
    ...session,
    nativeSession: {
      runtime: 'claude',
      id: result.sessionId,
      version: session.nativeSession?.version ?? 'unknown',
    },
  };
}
