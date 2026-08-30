import { join } from "node:path";
import { z } from "zod";
import { AppError } from "stitchkit";
import type { CodexCollaborationMode, MachineConfig, Session } from "../../types.ts";
import { log } from "../../util/log.ts";
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
export const CodexAppThreadContextSchema = z.object({
  thread: ThreadSchema,
  model: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  reasoningEffort: z.string().nullable().optional(),
}).passthrough();
export type CodexAppThreadContext = z.infer<typeof CodexAppThreadContextSchema>;

const CollaborationModePresetSchema = z.object({
  name: z.string(),
  mode: z.enum(["default", "plan"]).nullable(),
  model: z.string().min(1).nullable(),
  reasoning_effort: z.string().nullable().optional(),
}).passthrough();

export type CodexAppTurnPolicy = {
  collaborationMode: {
    mode: CodexCollaborationMode;
    settings: { model: string; reasoning_effort: string | null; developer_instructions: null };
  };
};

function collaborationUnavailable(session: Session, reason: string): never {
  log.error({ msg: "managed collaboration policy is unavailable", name: session.name,
    recipeId: session.launchRecipe?.id ?? null, mode: session.launchRecipe?.collaborationMode ?? null, reason });
  throw new AppError("COLLABORATION_MODE_UNAVAILABLE", "Managed collaboration policy is unavailable", 409);
}

/** Resolve the installed provider preset before accepting a turn. The caller cannot supply model,
 * effort or instructions: those values come from the loaded thread and provider catalog. */
export async function prepareManagedCodexTurn(
  rpc: CodexAppRpc,
  session: Session,
  context: CodexAppThreadContext,
): Promise<CodexAppTurnPolicy | undefined> {
  if (session.modelSelection !== undefined && (context.model !== session.modelSelection.model ||
      (context.modelProvider !== undefined && context.modelProvider !== session.modelSelection.provider)))
    collaborationUnavailable(session, "Loaded thread differs from its pinned model selection");
  const mode = session.launchRecipe?.collaborationMode;
  if (mode === undefined) return undefined;
  let presets: z.infer<typeof CollaborationModePresetSchema>[];
  try {
    const response = z.object({ data: z.array(CollaborationModePresetSchema) }).parse(
      await rpc.request("collaborationMode/list", {}),
    );
    presets = response.data;
  } catch (error) {
    return collaborationUnavailable(session, `provider capability probe failed: ${String(error)}`);
  }
  const preset = presets.find((candidate) => candidate.mode === mode);
  if (preset === undefined) collaborationUnavailable(session, `installed provider does not advertise ${mode}`);
  const model = context.model;
  if (model === undefined) collaborationUnavailable(session, "loaded thread did not report a model");
  return { collaborationMode: { mode, settings: {
    model,
    reasoning_effort: preset.reasoning_effort === undefined
      ? context.reasoningEffort ?? null
      : preset.reasoning_effort,
    developer_instructions: null,
  } } };
}
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
  const response = await resumeCodexAppThreadContext(rpc, threadId);
  return response.thread;
}

export async function resumeCodexAppThreadContext(rpc: CodexAppRpc, threadId: string): Promise<CodexAppThreadContext> {
  const response = CodexAppThreadContextSchema.parse(await rpc.request("thread/resume", { threadId }));
  if (response.thread.id !== threadId) throw new Error("Codex App Server resumed a different thread identity");
  return response;
}

export async function startCodexAppTurn(rpc: CodexAppRpc, threadId: string, messageId: string, text: string,
  policy?: CodexAppTurnPolicy): Promise<string> {
  const response = z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }).parse(await rpc.request("turn/start", {
    threadId,
    clientUserMessageId: messageId,
    input: [{ type: "text", text, text_elements: [] }],
    ...(policy ?? {}),
  }));
  return response.turn.id;
}
