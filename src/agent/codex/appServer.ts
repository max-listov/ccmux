import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { MachineConfig } from "../../types.ts";

const ThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({ type: z.literal("active"), activeFlags: z.array(z.string()).default([]) }),
]);

const ThreadItemSchema = z.object({
  type: z.string(),
  clientId: z.string().nullable().optional(),
}).passthrough();

const ThreadSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  source: z.unknown(),
  status: ThreadStatusSchema,
  canAcceptDirectInput: z.boolean().nullable(),
  turns: z.array(z.object({ items: z.array(ThreadItemSchema) }).passthrough()).default([]),
}).passthrough();

export type CodexAppThread = z.infer<typeof ThreadSchema>;
const RpcResponseSchema = z.object({
  id: z.number().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

export interface CodexAppRpc {
  userAgent?: string | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

const REQUEST_TIMEOUT_MS = 10_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function clientFrame(opcode: number, data: string | Buffer): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  if (extended === 0) header[1] = 0x80 | payload.length;
  else if (extended === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([header, masked]);
}

/** JSON-RPC over the private WebSocket control socket of the daemon the App already owns. */
export async function connectCodexAppServer(
  m: MachineConfig,
  options: { signal?: AbortSignal; maxMessageBytes?: number } = {},
): Promise<CodexAppRpc> {
  options.signal?.throwIfAborted();
  if (!m.codexHome) throw new Error("Codex home is not configured");
  const socketPath = join(m.codexHome, "app-server-control", "app-server-control.sock");
  if (!existsSync(socketPath)) throw new Error("Codex App Server control socket is unavailable");

  const socket = net.createConnection(socketPath);
  const maxBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let closed: Error | null = null;
  let handshake = Buffer.alloc(0);
  let frames = Buffer.alloc(0);
  let fragmented: Buffer[] | null = null;
  let fragmentBytes = 0;
  let resolveOpen: (() => void) | null = null;
  let rejectOpen: ((error: Error) => void) | null = null;

  const onText = (data: Buffer) => {
    let msg: z.infer<typeof RpcResponseSchema>;
    try { msg = RpcResponseSchema.parse(JSON.parse(data.toString())); } catch { return; }
    if (typeof msg.id !== "number") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(`App Server RPC failed: ${msg.error.message ?? `code ${msg.error.code ?? "unknown"}`}`));
    else waiter.resolve(msg.result);
  };
  const failAll = (error: Error) => {
    if (closed) return;
    closed = error;
    rejectOpen?.(error);
    rejectOpen = null;
    resolveOpen = null;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    options.signal?.removeEventListener("abort", onAbort);
    socket.destroy();
  };
  const onAbort = () => failAll(new Error("Codex App Server observation cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const parseFrames = () => {
    while (frames.length >= 2) {
      const first = frames[0] ?? 0;
      const second = frames[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (frames.length < 4) return;
        length = frames.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (frames.length < 10) return;
        const wide = frames.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return failAll(new Error("Codex App Server frame is too large"));
        length = Number(wide);
        offset = 10;
      }
      if (length > maxBytes || fragmentBytes + length > maxBytes) return failAll(new Error("Codex App Server message is too large"));
      const maskBytes = masked ? 4 : 0;
      if (frames.length < offset + maskBytes + length) return;
      const mask = masked ? frames.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(frames.subarray(offset, offset + length));
      frames = frames.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      if (opcode === 0x8) return failAll(new Error("Codex App Server closed the control socket"));
      if (opcode === 0x9) {
        socket.write(clientFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 && fin) onText(payload);
      else if (opcode === 0x1) { fragmented = [payload]; fragmentBytes = payload.length; }
      else if (opcode === 0x0 && fragmented !== null) {
        fragmented.push(payload);
        fragmentBytes += payload.length;
        if (fragmented.length > 1024) return failAll(new Error("Codex App Server message has too many fragments"));
        if (fin) {
          onText(Buffer.concat(fragmented));
          fragmented = null;
          fragmentBytes = 0;
        }
      }
    }
  };

  const key = randomBytes(16).toString("base64");
  socket.on("connect", () => {
    socket.write(
      `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
  socket.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (resolveOpen !== null) {
      handshake = Buffer.concat([handshake, bytes]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end > 16 * 1024 || (end === -1 && handshake.length > 16 * 1024)) return failAll(new Error("Codex App Server upgrade headers are too large"));
      if (end === -1) return;
      const headers = handshake.subarray(0, end).toString();
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (!headers.startsWith("HTTP/1.1 101") || !headers.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
        return failAll(new Error("Codex App Server rejected the WebSocket upgrade"));
      }
      frames = handshake.subarray(end + 4);
      handshake = Buffer.alloc(0);
      const done = resolveOpen;
      resolveOpen = null;
      rejectOpen = null;
      done();
      parseFrames();
      return;
    }
    if (frames.length + bytes.length > maxBytes + 64 * 1024) return failAll(new Error("Codex App Server receive buffer is too large"));
    frames = Buffer.concat([frames, bytes]);
    parseFrames();
  });
  socket.on("error", (error) => failAll(new Error(`Codex App Server connection failed: ${error.message}`)));
  socket.on("close", () => failAll(new Error("Codex App Server connection closed")));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      failAll(new Error("Codex App Server handshake timed out"));
    }, REQUEST_TIMEOUT_MS);
    resolveOpen = () => { clearTimeout(timer); resolve(); };
    rejectOpen = (error) => { clearTimeout(timer); reject(error); };
  });

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(closed);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.write(clientFrame(0x1, JSON.stringify({ method, id, params })), (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        reject(error);
      });
    });
  };

  let userAgent: string | undefined;
  try {
    const initialized = await request("initialize", {
      clientInfo: { name: "ccmux", title: "ccmux", version: "0" },
      capabilities: { experimentalApi: false },
    });
    userAgent = z.object({ userAgent: z.string().optional() }).parse(initialized).userAgent;
  } catch (error) {
    failAll(new Error("Codex App Server initialization failed"));
    throw error;
  }
  socket.write(clientFrame(0x1, JSON.stringify({ method: "initialized", params: {} })));
  return { userAgent, request, close: () => failAll(new Error("Codex App Server client closed")) };
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
  const response = z.object({ thread: ThreadSchema }).passthrough().parse(await rpc.request("thread/resume", { threadId }));
  return response.thread;
}

export async function startCodexAppTurn(rpc: CodexAppRpc, threadId: string, messageId: string, text: string): Promise<string> {
  const response = z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }).parse(await rpc.request("turn/start", {
    threadId,
    clientUserMessageId: messageId,
    input: [{ type: "text", text, text_elements: [] }],
  }));
  return response.turn.id;
}
