import type { MachineConfig, Session } from "../../types.ts";
import { readRuntimeInput, writeRuntimeInput } from "../../runtime/input.ts";
import type { OpenCodeClient } from "./server.ts";
import type { OpenCodeProjection } from "./projection.ts";
import { OpenCodeMessageSchema } from "./protocol.ts";
import { z } from "zod";
import { recordRuntimeDiagnostic } from "../../runtime/diagnostics.ts";

export async function applyOpenCodeInput(m: MachineConfig, session: Session, client: OpenCodeClient,
  projection: OpenCodeProjection, signal: AbortSignal): Promise<void> {
  const input = readRuntimeInput(m, session);
  const sessionID = session.nativeSession?.id;
  if (input === null || sessionID === undefined || input.phase === "accepted") return;
  if (input.phase === "dispatching" || input.phase === "uncertain") {
    try {
      const found = z.object({ info: OpenCodeMessageSchema }).parse((await client.session.message({ sessionID, messageID: input.nativeId }, { signal })).data);
      if (found.info.id !== input.nativeId || found.info.sessionID !== sessionID || found.info.role !== "user")
        throw new Error("Native input correlation mismatch");
      await writeRuntimeInput(m, session, { ...input, phase: "accepted" });
    } catch (error) {
      if (input.phase !== "uncertain") {
        await writeRuntimeInput(m, session, { ...input, phase: "uncertain" });
        await recordRuntimeDiagnostic(m, session.name, "input-correlation", error);
      }
    }
    return;
  }
  const observed = projection.snapshot();
  if (!observed.connected || observed.state !== "idle" || observed.turn?.status === "inProgress") return;
  await writeRuntimeInput(m, session, { ...input, phase: "dispatching" });
  projection.start(input.nativeId);
  // The user record is the native admission receipt. A lost HTTP response is reconciled on the
  // next tick; it must not replay the side-effecting prompt.
  try {
    await client.session.promptAsync({ sessionID, messageID: input.nativeId,
      ...(session.modelSelection === undefined ? {} : { model: {
        providerID: session.modelSelection.provider, modelID: session.modelSelection.model } }),
      parts: [{ type: "text", text: input.text }],
    }, { signal });
    await writeRuntimeInput(m, session, { ...input, phase: "accepted" });
  } catch (error) {
    signal.throwIfAborted();
    // Preserve the dispatching journal for exact native lookup, never a second POST.
    throw error;
  }
}
