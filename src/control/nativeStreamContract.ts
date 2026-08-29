import { z } from "zod";
import { ManagedPeerSchema } from "../config/schema.ts";
import { managedPeerKey } from "../chat/identity.ts";
import { CONTROL_MAX_BYTES, ControlNativeCursorSchema, ControlNativeSnapshotSchema } from "./schema.ts";

export const CCMUX_NATIVE_STREAM_PROFILE = "ccmux-native-v1";
export const CCMUX_NATIVE_STREAM_COMMAND = "control-native-stream";
export const CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES = 4096;
export const CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES = CONTROL_MAX_BYTES + 1024;
export const CCMUX_NATIVE_STREAM_HEARTBEAT_MS = 2000;

const ControlNativeStreamCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    target: ManagedPeerSchema,
    cursor: ControlNativeCursorSchema,
  })
  .strict();

const ControlNativeStreamCursorTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^ccn1_[A-Za-z0-9_-]+$/);

export const ControlNativeStreamRequestSchema = z
  .object({
    target: ManagedPeerSchema,
    cursor: ControlNativeStreamCursorTokenSchema.nullable().default(null),
  })
  .strict();
export type ControlNativeStreamRequest = z.output<typeof ControlNativeStreamRequestSchema>;

export const ControlNativeStreamCursorSchema = ControlNativeStreamCursorTokenSchema
  .transform((token, ctx) => {
    try {
      const encoded = token.slice(5).replace(/-/g, "+").replace(/_/g, "/");
      const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
      const binary = atob(encoded + padding);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return ControlNativeStreamCursorPayloadSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid native stream cursor" });
      return z.NEVER;
    }
  });

export const ControlNativeStreamFrameSchema = z
  .object({
    channel: z.literal("data"),
    data: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
        "native stream frame exceeds byte budget",
      ),
    cursor: ControlNativeStreamCursorTokenSchema,
  })
  .strict();

export function encodeControlNativeStreamCursor(
  target: z.output<typeof ManagedPeerSchema>,
  cursor: z.output<typeof ControlNativeCursorSchema>,
): string {
  const payload = JSON.stringify(ControlNativeStreamCursorPayloadSchema.parse({ v: 1, target, cursor }));
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ccn1_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export function readControlNativeStreamCursor(
  token: string | null,
  target: z.output<typeof ManagedPeerSchema>,
): z.output<typeof ControlNativeCursorSchema> | null {
  if (token === null) return null;
  const parsed = ControlNativeStreamCursorSchema.parse(token);
  if (managedPeerKey(parsed.target) !== managedPeerKey(target))
    throw new Error("Native stream cursor belongs to another target");
  return parsed.cursor;
}

export function controlNativeStreamFrame(snapshot: unknown) {
  const native = ControlNativeSnapshotSchema.parse(snapshot);
  return ControlNativeStreamFrameSchema.parse({
    channel: "data",
    data: JSON.stringify(native),
    cursor: encodeControlNativeStreamCursor(native.target, {
      generation: native.generation,
      sequence: native.sequence,
    }),
  });
}

export const CcmuxNativeStreamProfileSchema = z
  .object({
    bin: z.string().startsWith("/"),
    argv: z.tuple([z.literal(CCMUX_NATIVE_STREAM_COMMAND)]),
    callerArgs: z.object({ mode: z.literal("none") }).strict(),
    stdin: z
      .object({ mode: z.literal("text"), maxBytes: z.literal(CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES) })
      .strict(),
    env: z.object({ inherit: z.tuple([]), set: z.object({}).strict() }).strict(),
    timeoutMs: z.literal(900_000),
    maxBytes: z.literal(64 * 1024 * 1024),
    concurrency: z.literal(4),
    format: z.object({ mode: z.literal("ndjson"), stableCursor: z.literal(true) }).strict(),
  })
  .strict();

/** Operator supplies only the installed executable path; argv and framing remain owner-fixed. */
export function createCcmuxNativeStreamProfile(bin: string) {
  return CcmuxNativeStreamProfileSchema.parse({
    bin,
    argv: [CCMUX_NATIVE_STREAM_COMMAND],
    callerArgs: { mode: "none" },
    stdin: { mode: "text", maxBytes: CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES },
    env: { inherit: [], set: {} },
    timeoutMs: 900_000,
    maxBytes: 64 * 1024 * 1024,
    concurrency: 4,
    format: { mode: "ndjson", stableCursor: true },
  });
}
