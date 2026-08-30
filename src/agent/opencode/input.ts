import type { MachineConfig, Session } from "../../types.ts";
import { readRuntimeInput, writeRuntimeInput } from "../../runtime/input.ts";
import type { OpenCodeClient } from "./server.ts";
import type { OpenCodeProjection } from "./projection.ts";
import { OpenCodeMessageSchema } from "./protocol.ts";
import { z } from "zod";
import { recordRuntimeDiagnostic } from "../../runtime/diagnostics.ts";
import { resolveMessageAttachments } from "../../attachments/pins.ts";
import { withNativeAdmission } from "../../runtime/admission.ts";
import { contextMutationPending } from "../../context/store.ts";
import { readSelection } from "../../runtime/selection.ts";
import { pathToFileURL } from "node:url";
import { applicationPolicyEvidence, verifyApplicationPolicy } from "../../policy/resolve.ts";
import { selectOpenCodePolicyAgent } from "../../policy/opencode.ts";
import { policyUnavailable } from "../../policy/errors.ts";

export async function applyOpenCodeInput(m: MachineConfig, session: Session, client: OpenCodeClient,
  projection: OpenCodeProjection, signal: AbortSignal): Promise<void> {
  return withNativeAdmission(m, session, () => applyLocked(m, session, client, projection, signal));
}

async function applyLocked(m: MachineConfig, session: Session, client: OpenCodeClient,
  projection: OpenCodeProjection, signal: AbortSignal): Promise<void> {
  const input = readRuntimeInput(m, session);
  const sessionID = session.nativeSession?.id;
  if (input === null || sessionID === undefined) return;
  if (input.phase === "accepted" && (session.applicationPolicy === undefined ||
    projection.snapshot().applicationPolicy?.state === "applied")) return;
  const policy = session.applicationPolicy === undefined ? undefined
    : verifyApplicationPolicy(m, "opencode", session.applicationPolicy);
  const agent = policy === undefined ? undefined
    : selectOpenCodePolicyAgent(policy, (await client.app.agents({ directory: session.dir }, { signal })).data);
  if (input.phase === "dispatching" || input.phase === "uncertain" || input.phase === "accepted") {
    try {
      const found = z.object({ info: OpenCodeMessageSchema.extend({ agent: z.string().optional() }) }).parse(
        (await client.session.message({ sessionID, messageID: input.nativeId }, { signal })).data);
      if (found.info.id !== input.nativeId || found.info.sessionID !== sessionID || found.info.role !== "user")
        throw new Error("Native input correlation mismatch");
      if (policy !== undefined && found.info.agent !== agent) policyUnavailable(policy.metadata.id, "native-agent-receipt-mismatch");
      await writeRuntimeInput(m, session, { ...input, phase: "accepted" });
      if (policy !== undefined) projection.policyEvidence(applicationPolicyEvidence(policy, "applied"));
    } catch (error) {
      if (input.phase === "accepted") {
        if (policy !== undefined) projection.policyEvidence(applicationPolicyEvidence(policy, "unavailable"));
        throw error;
      }
      if (input.phase !== "uncertain") {
        await writeRuntimeInput(m, session, { ...input, phase: "uncertain" });
        await recordRuntimeDiagnostic(m, session.name, "input-correlation", error);
      }
    }
    return;
  }
  const observed = projection.snapshot();
  if (contextMutationPending(m, session)) return;
  if (!observed.connected || observed.state !== "idle" || observed.turn?.status === "inProgress") return;
  const options = input.turnOptions?.options ?? readSelection(m, session)?.options;
  if (options?.runtime !== "opencode") throw new Error("Native turn selection is unavailable");
  if (policy !== undefined && options.agent !== undefined && options.agent !== agent)
    policyUnavailable(policy.metadata.id, "native-agent-selection-conflicts-with-policy");
  const images = await resolveMessageAttachments(m, session, input.messageId, input.images ?? [], signal);
  await writeRuntimeInput(m, session, { ...input, phase: "dispatching" });
  projection.start(input.nativeId);
  // The user record is the native admission receipt. A lost HTTP response is reconciled on the
  // next tick; it must not replay the side-effecting prompt.
  try {
    await client.session.promptAsync({ sessionID, messageID: input.nativeId,
      model: { providerID: options.model.provider, modelID: options.model.model },
      ...(agent === undefined ? options.agent === undefined ? {} : { agent: options.agent } : { agent }),
      ...(options.variant === undefined ? {} : { variant: options.variant }),
      parts: [{ type: "text", text: input.text }, ...images.map(image => ({
        type: "file" as const, mime: image.reference.mediaType,
        filename: `${image.reference.id}.${image.reference.mediaType === "image/png" ? "png" : "jpg"}`,
        url: pathToFileURL(image.path).href,
      }))],
    }, { signal });
    await writeRuntimeInput(m, session, { ...input, phase: "accepted" });
    if (policy !== undefined) projection.policyEvidence(applicationPolicyEvidence(policy, "applied"));
  } catch (error) {
    signal.throwIfAborted();
    // Preserve the dispatching journal for exact native lookup, never a second POST.
    throw error;
  }
}
