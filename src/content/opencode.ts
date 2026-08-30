import { z } from "zod";
import { OpenCodeDeltaSchema, OpenCodeEventSchema, OpenCodeMessageSchema, OpenCodePartSchema, openCodeTerminal,
  type OpenCodeMessage, type OpenCodePart } from "../agent/opencode/protocol.ts";
import type { ContentBuffer } from "./buffer.ts";

/** Native reasoning parts are not summaries; only ordinary assistant text is public content here. */
export class OpenCodeContentObserver {
  private parents = new Map<string, string>();
  private partTypes = new Map<string, string>();
  constructor(private buffer: ContentBuffer, private nativeId: string) {}
  message(message: OpenCodeMessage): void {
    if (message.sessionID !== this.nativeId) return;
    const turn = message.role === "user" ? message.id : message.parentID;
    if (turn === undefined) return;
    this.parents.set(message.id, turn);
    while (this.parents.size > 256) {
      const oldest = this.parents.keys().next().value; if (oldest === undefined) break; this.parents.delete(oldest);
    }
    const outcome = openCodeTerminal(message);
    if (outcome !== null) {
      if (message.tokens) this.buffer.lifecycle("usage", turn, `${message.id}:usage`, "updated", JSON.stringify(message.tokens));
      this.buffer.lifecycle("terminal", turn, message.id, outcome);
    }
  }
  part(part: OpenCodePart): void {
    if (part.sessionID !== this.nativeId) return;
    this.partTypes.set(part.id, part.type);
    while (this.partTypes.size > 256) {
      const oldest = this.partTypes.keys().next().value; if (oldest === undefined) break; this.partTypes.delete(oldest);
    }
    const turn = this.parents.get(part.messageID);
    if (turn === undefined || turn === part.messageID) return;
    if (part.type === "text" && part.text !== undefined) this.buffer.text("assistant", turn, part.id, part.text, "replace", part.time?.end !== undefined);
    else if (part.type === "tool" && part.state) this.buffer.lifecycle("tool", turn, part.callID ?? part.id, part.state.status);
  }
  event(raw: unknown): void {
    const event = OpenCodeEventSchema.parse(raw);
    if (event.type === "message.updated") this.message(OpenCodeMessageSchema.parse(z.object({ info: z.unknown() }).parse(event.properties).info));
    else if (event.type === "message.part.updated") this.part(OpenCodePartSchema.parse(z.object({ part: z.unknown() }).parse(event.properties).part));
    else if (event.type === "message.part.delta") {
      const delta = OpenCodeDeltaSchema.parse(event.properties), turn = this.parents.get(delta.messageID);
      if (delta.sessionID === this.nativeId && delta.field === "text" && this.partTypes.get(delta.partID) === "text" && turn !== undefined && turn !== delta.messageID)
        this.buffer.text("assistant", turn, delta.partID, delta.delta, "append");
    } else if (["permission.asked", "question.asked", "permission.replied", "question.replied", "question.rejected"].includes(event.type)) {
      const request = z.object({ sessionID: z.string(), id: z.string().optional(), requestID: z.string().optional() }).parse(event.properties);
      const id = request.id ?? request.requestID;
      if (request.sessionID === this.nativeId && id !== undefined) this.buffer.lifecycle("request", null, id, event.type.endsWith("asked") ? "requested" : "resolved");
    }
  }
}
