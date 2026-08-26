import { z } from "zod";
import {
  appThreadHoldReason,
  connectCodexAppServer,
  readCodexAppThread,
  resumeCodexAppThread,
  startCodexAppTurn,
  type CodexAppRpc,
} from "../agent/codex/appServer.ts";
import { codexAppMessagePersisted } from "../agent/codex/appPickup.ts";
import type { ChatMessage, CodexAppPeer, MachineConfig } from "../types.ts";
import { codexAppPeer } from "./identity.ts";

export function currentCodexAppThreadId(env: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = z.uuid().safeParse(env.CODEX_THREAD_ID);
  return parsed.success ? parsed.data : null;
}

export async function resolveCodexAppPeer(
  m: MachineConfig,
  threadId: string,
  connect: (m: MachineConfig) => Promise<CodexAppRpc> = connectCodexAppServer,
): Promise<CodexAppPeer> {
  const rpc = await connect(m);
  try {
    const thread = await readCodexAppThread(rpc, z.uuid().parse(threadId));
    return codexAppPeer(m.rcPrefix, thread.id, thread.name);
  } finally {
    rpc.close();
  }
}

export type CodexAppDelivery =
  | { delivered: true; duplicate: boolean; turnId: string | null }
  | { delivered: false; reason: string };

/** Deliver one immutable ledger message to one exact App thread. Existing client-message evidence
 * closes the crash window between App Server acceptance and ccmux cursor persistence. */
export async function deliverCodexAppMessage(
  m: MachineConfig,
  msg: ChatMessage,
  text: string,
  connect: (m: MachineConfig) => Promise<CodexAppRpc> = connectCodexAppServer,
  persisted: (m: MachineConfig, threadId: string, messageId: string) => Promise<boolean> = codexAppMessagePersisted,
): Promise<CodexAppDelivery> {
  if (msg.to.kind !== "codex-app") return { delivered: false, reason: "recipient is not a Codex App thread" };
  if (msg.to.machine !== m.rcPrefix) return { delivered: false, reason: "Codex App recipient belongs to another machine" };
  if (await persisted(m, msg.to.threadId, msg.id)) return { delivered: true, duplicate: true, turnId: null };
  const rpc = await connect(m);
  try {
    let thread = await readCodexAppThread(rpc, msg.to.threadId);
    const initialHold = appThreadHoldReason(thread);
    if (initialHold !== null) return { delivered: false, reason: initialHold };
    if (thread.status.type === "notLoaded") {
      thread = await resumeCodexAppThread(rpc, msg.to.threadId);
      // Resume can race a turn started by another App client. Re-read with turns before deciding,
      // so a prior accepted delivery wins over a transient active status and is never duplicated.
      thread = await readCodexAppThread(rpc, msg.to.threadId);
      const resumedHold = appThreadHoldReason(thread);
      if (resumedHold !== null) return { delivered: false, reason: resumedHold };
      if (thread.status.type !== "idle") return { delivered: false, reason: `Codex App thread resumed into ${thread.status.type}` };
    }
    if (thread.status.type !== "idle") return { delivered: false, reason: `Codex App thread is ${thread.status.type}` };
    const turnId = await startCodexAppTurn(rpc, msg.to.threadId, msg.id, text);
    return { delivered: true, duplicate: false, turnId };
  } finally {
    rpc.close();
  }
}
