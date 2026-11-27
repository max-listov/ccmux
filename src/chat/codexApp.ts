import { JsonRpcError } from 'stitchkit/agent-executor';
import type { CodexControlConnection } from 'stitchkit/agent-executor/codex';
import { z } from 'zod';
import { codexAppMessagePersisted } from '../agent/codex/appPickup.ts';
import {
  appThreadHoldReason,
  readCodexAppThread,
  resumeCodexAppThread,
} from '../agent/codex/appServer.ts';
import { connectCodexAppServerControl } from '../agent/codex/owned/rpc.ts';
import type { ChatMessage, CodexAppPeer, MachineConfig } from '../types.ts';
import { codexAppPeer } from './identity.ts';

export type CodexAppResolveClient = Pick<CodexControlConnection, 'readThread' | 'close'>;

export function currentCodexAppThreadId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (
    env.CODEX_THREAD_ID === undefined &&
    env.CODEX_APP_TOOLS_PIPE_PATH === undefined &&
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== 'Codex Desktop'
  )
    return null;
  const parsed = z.uuid().safeParse(env.CODEX_THREAD_ID);
  if (!parsed.success) throw new Error('Codex sender requires a valid CODEX_THREAD_ID');
  return parsed.data;
}

export async function resolveCodexAppPeer(
  m: MachineConfig,
  threadId: string,
  connect: (m: MachineConfig) => Promise<CodexAppResolveClient> = connectCodexAppServerControl,
): Promise<CodexAppPeer> {
  const id = z.uuid().parse(threadId);
  const controls = await connect(m);
  try {
    const thread = await readCodexAppThread(controls, id);
    return codexAppPeer(m.rcPrefix, thread.id, thread.name);
  } finally {
    await controls.close().catch(() => {});
  }
}

export type CodexAppDelivery =
  | { delivered: true; duplicate: boolean; turnId: string | null }
  | { delivered: false; reason: string };

/** Deliver one immutable ledger message to one exact App thread. Existing client-message evidence
 * closes the crash window between App Server acceptance and stitchmux cursor persistence. */
export async function deliverCodexAppMessage(
  m: MachineConfig,
  msg: ChatMessage,
  text: string,
  connect: (
    m: MachineConfig,
  ) => Promise<
    Pick<CodexControlConnection, 'readThread' | 'resumeThread' | 'startThreadTurn' | 'close'>
  > = connectCodexAppServerControl,
  persisted: (
    m: MachineConfig,
    threadId: string,
    messageId: string,
  ) => Promise<boolean> = codexAppMessagePersisted,
): Promise<CodexAppDelivery> {
  if (msg.to.kind !== 'codex-app')
    return { delivered: false, reason: 'recipient is not a Codex App thread' };
  if (msg.to.machine !== m.rcPrefix)
    return { delivered: false, reason: 'Codex App recipient belongs to another machine' };
  if (await persisted(m, msg.to.threadId, msg.id))
    return { delivered: true, duplicate: true, turnId: null };
  const controls = await connect(m);
  try {
    let thread = await readCodexAppThread(controls, msg.to.threadId);
    const initialHold = appThreadHoldReason(thread);
    if (initialHold !== null) return { delivered: false, reason: initialHold };
    if (thread.status.type === 'notLoaded') {
      await resumeCodexAppThread(controls, msg.to.threadId);
      // Resume can race a turn started by another App client. Re-read before deciding,
      // so a prior accepted delivery wins over a transient active status and is never duplicated.
      thread = await readCodexAppThread(controls, msg.to.threadId);
      const resumedHold = appThreadHoldReason(thread);
      if (resumedHold !== null) return { delivered: false, reason: resumedHold };
      if (thread.status.type !== 'idle')
        return { delivered: false, reason: `Codex App thread resumed into ${thread.status.type}` };
    }
    if (thread.status.type !== 'idle')
      return { delivered: false, reason: `Codex App thread is ${thread.status.type}` };
    const { turnId } = await controls.startThreadTurn({
      threadId: msg.to.threadId,
      clientId: msg.id,
      input: text.length ? [{ type: 'text', text }] : [],
    });
    return { delivered: true, duplicate: false, turnId };
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    return { delivered: false, reason: `App Server RPC failed: ${error.message}` };
  } finally {
    await controls.close();
  }
}
