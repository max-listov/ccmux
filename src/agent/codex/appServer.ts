import { join } from "node:path";
import { z } from "zod";
import type { MachineConfig } from "../../types.ts";
import { connectCodexSocket } from "./socket.ts";
import type { CodexAppRpc, CodexRpcOptions } from "./rpc.ts";
export type { CodexAppRpc } from "./rpc.ts";

export const ThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({ type: z.literal("active"), activeFlags: z.array(z.string()) }),
]);

const ThreadItemSchema = z.object({
  type: z.string(),
  clientId: z.string().nullable().optional(),
}).passthrough();

export const ThreadSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  source: z.unknown(),
  status: ThreadStatusSchema,
  canAcceptDirectInput: z.boolean().nullable(),
  turns: z.array(z.object({ items: z.array(ThreadItemSchema) }).passthrough()).default([]),
}).passthrough();

export type CodexAppThread = z.infer<typeof ThreadSchema>;
export function connectCodexAppServer(m: MachineConfig, options: CodexRpcOptions = {}): Promise<CodexAppRpc> {
  if (!m.codexHome) return Promise.reject(new Error("Codex home is not configured"));
  return connectCodexSocket(join(m.codexHome, "app-server-control", "app-server-control.sock"), options);
}

export async function readCodexAppThread(rpc: CodexAppRpc, threadId: string, includeTurns = false): Promise<CodexAppThread> {
  const response = z.object({ thread: ThreadSchema }).parse(await rpc.request("thread/read", { threadId, includeTurns }));
  if (response.thread.id !== threadId) throw new Error("Codex App Server returned a different thread identity");
  return response.thread;
}

export function appThreadHoldReason(thread: CodexAppThread): string | null {
  if (thread.status.type === "active") {
    const flags = thread.status.activeFlags.length > 0 ? ` (${thread.status.activeFlags.join(", ")})` : "";
    return `Codex App thread is active${flags}; delivery waits for an idle turn boundary`;
  }
  if (thread.status.type === "systemError") return "Codex App thread is in systemError";
  if (thread.status.type === "idle" && thread.canAcceptDirectInput !== true) return "Codex App thread does not currently accept direct input";
  return null;
}

export async function resumeCodexAppThread(rpc: CodexAppRpc, threadId: string): Promise<CodexAppThread> {
  const response = z.object({ thread: ThreadSchema }).passthrough().parse(await rpc.request("thread/resume", { threadId }));
  if (response.thread.id !== threadId) throw new Error("Codex App Server resumed a different thread identity");
  return response.thread;
}

export async function startCodexAppTurn(rpc: CodexAppRpc, threadId: string, messageId: string, text: string): Promise<string> {
  const response = z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }).parse(await rpc.request("turn/start", {
    threadId,
    clientUserMessageId: messageId,
    input: [{ type: "text", text, text_elements: [] }],
  }));
  return response.turn.id;
}
