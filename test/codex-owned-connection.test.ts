import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { mkdtempSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { makeMachine, makeSession, UUID } from "./helpers.ts";
import { ownedCodexSocket, privateRuntimeDirectory } from "../src/agent/codex/ownedPaths.ts";
import { OwnedCodexConnection } from "../src/agent/codex/ownedConnection.ts";
import { readOwnedCodexStatus } from "../src/agent/codex/ownedStatus.ts";
import { OWNED_CODEX_OMIT_NOTIFICATIONS } from "../src/agent/codex/ownedRpc.ts";
import { supportsOwnedCodexVersion } from "../src/agent/codex/ownedLaunch.ts";
import { readEvents } from "../src/events/feed.ts";

function fixture() {
  const m = makeMachine({ stateDir: mkdtempSync("/tmp/ccmux-native-connection-"), sessionEvents: true });
  const s = makeSession({ agent: "codex", runtime: "app-server", eventsEnabled: true });
  const path = ownedCodexSocket(m, s.name); privateRuntimeDirectory(dirname(path));
  let client: ServerWebSocket<unknown> | null = null;
  let admissionRace = true, readRace = true, wrongIdentity = false;
  let native: unknown = { type: "idle" };
  const requests: string[] = [];
  const send = (method: string, params: unknown) => client?.send(JSON.stringify({ method, params }));
  const turn = (status: string) => ({ threadId: s.uuid, turn: { id: "turn-a", status } });
  const server = Bun.serve<unknown>({ unix: path,
    fetch(request, server) { if (server.upgrade(request, { data: undefined })) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { client = ws; },
      message(ws, raw) {
        const message = z.object({ id: z.number().optional(), method: z.string(), params: z.unknown() }).parse(JSON.parse(String(raw)));
        requests.push(message.method);
        const respond = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
        if (message.method === "initialize") {
          expect(message.params).toMatchObject({ capabilities: { experimentalApi: true, optOutNotificationMethods: OWNED_CODEX_OMIT_NOTIFICATIONS } });
          respond({ userAgent: "codex/0.147.0" });
        }
        if (message.method === "thread/resume" || message.method === "thread/read") {
          if (message.method === "thread/resume" && admissionRace) { send("turn/started", turn("inProgress")); admissionRace = false; }
          if (message.method === "thread/read" && readRace) {
            send("thread/status/changed", { threadId: s.uuid, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
            readRace = false;
          }
          respond({ thread: { id: wrongIdentity ? crypto.randomUUID() : s.uuid, name: null, source: "cli", status: native, canAcceptDirectInput: true } });
        }
        if (message.method === "thread/turns/list") respond({ data: [{ id: "turn-a", status: "inProgress" }] });
      },
    },
  });
  return { m, s, requests, send, turn,
    setNative(value: unknown) { native = value; },
    mismatch() { wrongIdentity = true; },
    disconnect() { client?.close(); }, close() { server.stop(true); },
  };
}

test("native subscription precedes snapshots, reconnect changes generation and retired connections cannot replay history", async () => {
  const f = fixture();
  const first = new OwnedCodexConnection(f.m, f.s, process.pid);
  let next: OwnedCodexConnection | null = null;
  try {
    await first.open(new AbortController().signal); await first.admit(false, new AbortController().signal);
    const baseline = readOwnedCodexStatus(f.m, f.s);
    expect(baseline.snapshot).toMatchObject({ state: "waiting-approval", turn: { id: "turn-a", status: "inProgress" } });
    expect(readEvents(f.m)).toEqual([]); // no history notifications at admission
    first.activateEvents(f.s);
    f.send("turn/completed", f.turn("completed"));
    const deadline = Date.now() + 2000;
    while (readOwnedCodexStatus(f.m, f.s).snapshot?.turn?.status !== "completed" && Date.now() < deadline) await Bun.sleep(5);
    expect(readOwnedCodexStatus(f.m, f.s).snapshot?.turn?.status).toBe("completed");
    expect(readEvents(f.m).map(({ event, threadId }) => ({ event, threadId }))).toEqual([{ event: "turn-end", threadId: UUID }]);
    f.disconnect();
    await Bun.sleep(20);
    await expect(first.refresh(f.s)).rejects.toThrow();
    await first.close("disconnected");
    expect(readOwnedCodexStatus(f.m, f.s).status).toBe("unavailable");
    next = new OwnedCodexConnection(f.m, f.s, process.pid);
    await next.open(new AbortController().signal); await next.admit(false, new AbortController().signal);
    const resumed = readOwnedCodexStatus(f.m, f.s);
    expect(resumed.status).toBe("live"); expect(resumed.snapshot?.generation).not.toBe(baseline.snapshot?.generation);
    expect(resumed.snapshot?.state).toBe("idle");
    await first.close("late-retired-close");
    expect(readOwnedCodexStatus(f.m, f.s).snapshot?.generation).toBe(resumed.snapshot?.generation);
    expect(f.requests.filter((method) => method === "thread/resume")).toHaveLength(2);
    expect(f.requests).not.toContain("thread/start"); expect(f.requests).not.toContain("turn/start");
    expect(readEvents(f.m)).toHaveLength(1);
  } finally { await first.close("stopped"); await next?.close("stopped"); f.close(); }
});

test("mismatched native resume and malformed active flags never admit an idle replacement", async () => {
  const f = fixture(), connection = new OwnedCodexConnection(f.m, f.s, process.pid);
  try {
    await connection.open(new AbortController().signal);
    f.mismatch();
    await expect(connection.admit(false, new AbortController().signal)).rejects.toThrow("different thread identity");
    expect(readOwnedCodexStatus(f.m, f.s).status).toBe("unavailable");
    expect(f.requests).not.toContain("thread/start");
  } finally { await connection.close("stopped"); f.close(); }
  const malformed = fixture(), second = new OwnedCodexConnection(malformed.m, malformed.s, process.pid);
  try {
    malformed.setNative({ type: "active" });
    await second.open(new AbortController().signal);
    await expect(second.admit(false, new AbortController().signal)).rejects.toThrow();
    expect(readOwnedCodexStatus(malformed.m, malformed.s).status).toBe("unavailable");
  } finally { await second.close("stopped"); malformed.close(); }
});

test("native version floor excludes older/unknown/floor prerelease binaries", () => {
  for (const version of ["codex-cli 0.147.0", "codex-cli 0.147.0+build.1", "codex-cli 0.150.0-alpha.8", "codex-cli 1.0.0"]) expect(supportsOwnedCodexVersion(version)).toBe(true);
  for (const version of ["unknown", "codex-cli 0.146.0", "codex-cli 0.147.0-alpha.1", "codex-cli 0.150.0-..", "codex-cli 0.150.0invalid"]) expect(supportsOwnedCodexVersion(version)).toBe(false);
});
