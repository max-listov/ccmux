import { z } from "zod";
import { AgentKindSchema } from "../config/schema.ts";
import type { Session } from "../types.ts";

export const RuntimeCapabilitiesSchema = z.object({
  runtime: AgentKindSchema,
  structured: z.boolean(),
  modelCatalog: z.boolean(),
  modelSelection: z.boolean(),
  approval: z.boolean(),
  input: z.boolean(),
  nativeStream: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
  imageInput: z.boolean(),
  selectionDefaults: z.boolean(),
  turnOptions: z.boolean(),
  turnSteering: z.boolean(),
  history: z.boolean(),
  fork: z.boolean(),
  compaction: z.boolean(),
  rollback: z.boolean(),
  applicationPolicy: z.boolean(),
}).strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export const RuntimeCatalogInputSchema = z.object({}).strict();
export const RuntimeCatalogSchema = z.object({ runtimes: z.array(z.object({
  runtime: AgentKindSchema, availability: z.enum(["configured", "unavailable"]),
  reason: z.string().nullable(), capabilities: RuntimeCapabilitiesSchema,
}).strict()).max(4) }).strict();

const unsupportedNativeOperations = { imageInput: false, selectionDefaults: false, turnOptions: false,
  turnSteering: false, history: false, fork: false, compaction: false, rollback: false, applicationPolicy: false };
const nativeOperations = { ...unsupportedNativeOperations, imageInput: true, selectionDefaults: true,
  turnOptions: true, history: true, fork: true, compaction: true, applicationPolicy: true };
const capabilities = {
  claude: { runtime: "claude", structured: false, modelCatalog: false, modelSelection: false,
    approval: false, input: false, nativeStream: false, interrupt: false, resume: true, ...unsupportedNativeOperations },
  codex: { runtime: "codex", structured: true, modelCatalog: true, modelSelection: true,
    approval: true, input: true, nativeStream: true, interrupt: true, resume: true, ...nativeOperations, turnSteering: true },
  opencode: { runtime: "opencode", structured: true, modelCatalog: true, modelSelection: true,
    approval: true, input: true, nativeStream: true, interrupt: true, resume: true, ...nativeOperations },
  custom: { runtime: "custom", structured: false, modelCatalog: false, modelSelection: false,
    approval: false, input: false, nativeStream: false, interrupt: false, resume: false, ...unsupportedNativeOperations },
} satisfies Record<Session["agent"], RuntimeCapabilities>;

export function runtimeCapabilities(session: Pick<Session, "agent" | "runtime">): RuntimeCapabilities {
  const declared = capabilities[session.agent];
  if (!hasNativeRuntime(session))
    return { ...declared, structured: false, modelCatalog: false, modelSelection: false,
      approval: false, input: false, nativeStream: false, interrupt: false, ...unsupportedNativeOperations };
  return { ...declared };
}

export function hasNativeRuntime(session: Pick<Session, "agent" | "runtime">): boolean {
  return (session.agent === "codex" && session.runtime === "app-server") ||
    (session.agent === "opencode" && session.runtime === "native");
}
