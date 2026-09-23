import { admitNativeFork, type NativeForkIntent } from '../../../context/fork.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { codexAppMessagePersisted } from '../appPickup.ts';
import {
  type CodexAppThreadContext,
  CodexAppThreadContextSchema,
  prepareManagedCodexTurn,
  startCodexAppTurn,
} from '../appServer.ts';
import { rolloutReadiness } from '../resume.ts';
import { CODEX_THREAD_BOOTSTRAP_TIMEOUT_MS, type CodexAppRpc } from '../rpc.ts';
import { codexTextInput } from '../turnInput.ts';
import { ownedCodexThreadParams } from './launch.ts';

const BOOTSTRAP_PROMPT =
  'Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.';

/**
 * Start, resume or fork the thread this connection serves.
 *
 * A fork goes through the admission ledger rather than straight to the server: a fork whose
 * acknowledgement was lost must never be dispatched twice, because the second one silently
 * duplicates a conversation.
 */
export async function openOwnedThread(
  rpc: CodexAppRpc,
  m: MachineConfig,
  initial: Session,
  fresh: boolean,
  fork: NativeForkIntent | null,
  signal: AbortSignal,
): Promise<CodexAppThreadContext> {
  const request = async (method: string, params: Record<string, unknown>) =>
    CodexAppThreadContextSchema.parse(
      await rpc.request(
        method,
        { ...ownedCodexThreadParams(initial, m), ...params },
        { timeoutMs: CODEX_THREAD_BOOTSTRAP_TIMEOUT_MS },
      ),
    );
  if (fork === null)
    return fresh
      ? request('thread/start', {})
      : request('thread/resume', { threadId: initial.uuid, excludeTurns: true });
  return admitNativeFork(
    m,
    initial,
    {
      fork: async (source, nativeSignal) => {
        nativeSignal.throwIfAborted();
        return request('thread/fork', {
          threadId: source.nativeId,
          ...(source.turnId === null ? {} : { lastTurnId: source.turnId }),
          excludeTurns: true,
          deferGoalContinuation: true,
        });
      },
      identity: (result) => result.thread.id,
      resume: async (threadId, nativeSignal) => {
        nativeSignal.throwIfAborted();
        return request('thread/resume', {
          threadId,
          excludeTurns: true,
          deferGoalContinuation: true,
        });
      },
    },
    signal,
  );
}

/**
 * Give a new thread its first turn and wait until the provider has written it down.
 *
 * Admission is only honest once the rollout's metadata is readable: before that, a reader that
 * resolves the session by its rollout finds nothing, and a restart would not find the thread.
 */
export async function bootstrapOwnedThread(input: {
  rpc: CodexAppRpc;
  m: MachineConfig;
  session: Session;
  /** The client message id of the bootstrap turn — immutable, so a retry is the same turn. */
  clientId: string;
  response: CodexAppThreadContext;
  signal: AbortSignal;
  /** Throws once the connection has failed or closed. */
  alive: () => void;
  /** The turn was accepted. */
  started: () => void;
}): Promise<void> {
  const { rpc, m, session } = input;
  const policy = await prepareManagedCodexTurn(rpc, m, session, input.response);
  const start = async () => {
    await startCodexAppTurn(
      rpc,
      session.uuid,
      input.clientId,
      codexTextInput(BOOTSTRAP_PROMPT),
      policy,
    );
    input.started();
  };
  const deadline = Date.now() + m.codexCorrelationTimeoutMs;
  let turnError: unknown = null;
  try {
    await start();
  } catch (error) {
    turnError = error;
  }
  let rollout = rolloutReadiness(session, m);
  while (rollout.status !== 'ready' && Date.now() < deadline) {
    input.signal.throwIfAborted();
    input.alive();
    await Bun.sleep(50);
    rollout = rolloutReadiness(session, m);
  }
  if (rollout.status !== 'ready')
    throw new Error(
      `Native session rollout metadata did not become readable before admission (${rollout.detail}; turn=${String(turnError)})`,
    );
  if (turnError === null) return;
  // A provider can expose the rollout inode before committing session_meta, then reject the first
  // turn while its own thread store is between those two states. Retry only that named pre-dispatch
  // failure, with the same immutable client id, and first rule out a persisted acceptance after a
  // lost response.
  if (!/thread-store.*(?:rollout is empty|session metadata)/i.test(String(turnError)))
    throw turnError;
  if (!(await codexAppMessagePersisted(m, session.uuid, input.clientId))) await start();
}
