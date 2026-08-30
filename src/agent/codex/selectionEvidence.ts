import { z } from "zod";
import type { CodexRpcEvent } from "./rpc.ts";
import { NativeModelSelectionSchema, NativeTurnOptionsSchema, type NativeSelectionEvidence } from "../../runtime/selectionSchema.ts";

const Settings = z.object({ threadId: z.string(), threadSettings: z.object({
  model: z.string(), modelProvider: z.string(), effort: z.string().nullable(),
  collaborationMode: z.object({ mode: z.enum(["default", "plan"]) }),
}) });
const Reroute = z.object({ threadId: z.string(), turnId: z.string(), toModel: z.string() });

/** Native settings events carry effective configuration; desired defaults never masquerade as it. */
export function codexSelectionEvent(event: CodexRpcEvent, threadId: string,
  previous: NativeSelectionEvidence | null): NativeSelectionEvidence | null {
  if (event.method === "thread/settings/updated") {
    const { threadId: id, threadSettings: settings } = Settings.parse(event.params);
    if (id !== threadId) return null;
    const model = NativeModelSelectionSchema.parse({ provider: settings.modelProvider, model: settings.model });
    return { model, options: NativeTurnOptionsSchema.parse({ runtime: "codex", model,
      mode: settings.collaborationMode.mode, ...(settings.effort === null ? {} : { effort: settings.effort }) }),
      source: "settings", turnId: null };
  }
  if (event.method === "model/rerouted") {
    const data = Reroute.parse(event.params);
    if (data.threadId !== threadId || previous === null) return null;
    return { model: NativeModelSelectionSchema.parse({ ...previous.model, model: data.toModel }),
      options: null, source: "reroute", turnId: data.turnId };
  }
  return null;
}
