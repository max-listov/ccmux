import { expect, test } from "bun:test";
import { boundedOpenCodeFetch, OPENCODE_HTTP_MAX_BYTES, OPENCODE_EVENT_MAX_BYTES } from "../src/agent/opencode/http.ts";

test("native HTTP rejects oversized JSON and redirects before SDK decoding", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/redirect" ? Response.redirect("http://127.0.0.1:1/")
      : new Response("x".repeat(OPENCODE_HTTP_MAX_BYTES + 1), { headers: { "content-type": "application/json" } });
  } });
  try {
    await expect((await boundedOpenCodeFetch(server.url)).text()).rejects.toThrow("bounded frame");
    await expect(boundedOpenCodeFetch(new URL("/redirect", server.url))).rejects.toThrow();
  } finally { await server.stop(true); }
});

test("native SSE limits apply per frame, including fragmented CRLF delimiters", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const oversized = new URL(request.url).pathname === "/large";
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      if (oversized) controller.enqueue(Buffer.from("data: " + "x".repeat(OPENCODE_EVENT_MAX_BYTES)));
      else for (let i = 0; i < 12; i++) {
        controller.enqueue(Buffer.from("data: " + "x".repeat(24_000) + "\r\n\r"));
        controller.enqueue(Buffer.from("\n"));
      }
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    expect((await (await boundedOpenCodeFetch(server.url)).text()).length).toBeGreaterThan(OPENCODE_EVENT_MAX_BYTES);
    await expect((await boundedOpenCodeFetch(new URL("/large", server.url))).text()).rejects.toThrow("bounded frame");
  } finally { await server.stop(true); }
});
