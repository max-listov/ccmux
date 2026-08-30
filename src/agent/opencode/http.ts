/** Bound SDK response bodies and individual SSE frames before its JSON/SSE decoder allocates them. */
import { InlineImageElider } from "./imageElision.ts";
export const OPENCODE_HTTP_MAX_BYTES = 2 * 1024 * 1024;
export const OPENCODE_EVENT_MAX_BYTES = 256 * 1024;

export const boundedOpenCodeFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (response.body === null) return response;
  const streaming = response.headers.get("content-type")?.startsWith("text/event-stream") === true;
  let size = 0;
  let previous = -1;
  let elider = new InlineImageElider();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output: number[] = [];
      const emit = (byte: number) => {
        if (++size > (streaming ? OPENCODE_EVENT_MAX_BYTES : OPENCODE_HTTP_MAX_BYTES))
          throw new Error("Native response exceeded its bounded frame size");
        if (streaming && byte === 10 && previous === 10) { size = 0; elider = new InlineImageElider(); }
        if (byte !== 13) previous = byte;
        output.push(byte);
      };
      for (const byte of chunk) {
        elider.feed(byte, emit);
      }
      if (output.length) controller.enqueue(Uint8Array.from(output));
    },
    flush(controller) {
      const output: number[] = [];
      elider.finish(byte => output.push(byte));
      if (output.length) controller.enqueue(Uint8Array.from(output));
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}, { preconnect: fetch.preconnect });
