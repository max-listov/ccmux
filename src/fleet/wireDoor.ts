import { createUnixClientTransport } from "stitchkit/server";

export const WIRE_DOOR_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const WIRE_DOOR_MAX_RESPONSE_BYTES = 52 * 1024 * 1024;
export const WIRE_DOOR_MAX_HEADER_BYTES = 64 * 1024;

export type WireDoorRequest = {
  socket: string;
  body: string;
  deadlineMs: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
};

/** One bounded Unix-only request. The deadline remains attached while the body is consumed, and
 * closing the owned transport settles every socket on success, refusal, limit, timeout or cancel. */
export async function callWireDoor(input: WireDoorRequest): Promise<{ response: Response; body: string }> {
  const timeout = AbortSignal.timeout(input.deadlineMs);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);
  const transport = createUnixClientTransport({
    socketPath: input.socket,
    maxConnections: 1,
    maxRequestBytes: WIRE_DOOR_MAX_REQUEST_BYTES,
    maxResponseBytes: input.maxResponseBytes ?? WIRE_DOOR_MAX_RESPONSE_BYTES,
    maxHeaderBytes: WIRE_DOOR_MAX_HEADER_BYTES,
    headersTimeoutMs: input.deadlineMs,
    maxRedirects: 0,
  });
  try {
    const response = await transport.fetch("http://localhost/wire/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input.body,
      signal,
    });
    return { response, body: await response.text() };
  } finally {
    await transport.close();
  }
}
