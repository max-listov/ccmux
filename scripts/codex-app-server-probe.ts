#!/usr/bin/env bun

import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const JsonRpcMessageSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
      })
      .optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
  })
  .passthrough();

const ThreadResponseSchema = z.object({
  thread: z
    .object({
      id: z.string(),
      status: z.object({ type: z.string() }).passthrough().optional(),
    })
    .passthrough(),
});

const ThreadListResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        status: z.object({ type: z.string() }).passthrough(),
      })
      .passthrough(),
  ),
});

const TurnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(z.unknown()),
  }),
});

const AgentMessageItemSchema = z.object({
  type: z.literal("agentMessage"),
  text: z.string(),
});

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function startClient(codexHome: string) {
  const process = Bun.spawn(["env", `CODEX_HOME=${codexHome}`, "codex", "app-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<number, PendingRequest>();
  const notificationWaiters = new Map<string, Array<(params: unknown) => void>>();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stopped = false;

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  const stdoutDone = (async () => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of process.stdout) {
        stdoutBuffer += decoder.decode(chunk, { stream: true });
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline === -1) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const message = JsonRpcMessageSchema.parse(JSON.parse(line));
          if (message.method && message.id === undefined) {
            const waiters = notificationWaiters.get(message.method);
            const waiter = waiters?.shift();
            if (waiters?.length === 0) notificationWaiters.delete(message.method);
            waiter?.(message.params);
            continue;
          }
          if (typeof message.id !== "number") continue;
          const request = pending.get(message.id);
          if (!request) continue;
          pending.delete(message.id);
          if (message.error) {
            request.reject(new Error(`${message.error.code}: ${message.error.message}`));
          } else {
            request.resolve(message.result);
          }
        }
      }
      if (!stopped) rejectPending(new Error("app-server stdout closed"));
    } catch (error) {
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of process.stderr) stderrBuffer += decoder.decode(chunk, { stream: true });
  })();

  function send(message: object): void {
    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method: string, params: object = {}): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ method, id, params });
    });
  }

  async function initialize(): Promise<void> {
    await request("initialize", {
      clientInfo: { name: "ccmux_probe", title: "ccmux probe", version: "1" },
    });
    send({ method: "initialized", params: {} });
  }

  function waitForNotification(method: string): Promise<unknown> {
    return new Promise((resolve) => {
      const waiters = notificationWaiters.get(method) ?? [];
      waiters.push(resolve);
      notificationWaiters.set(method, waiters);
    });
  }

  async function waitForExit(timeoutMs: number): Promise<number | null> {
    return Promise.race([process.exited, Bun.sleep(timeoutMs).then(() => null)]);
  }

  async function forceBoundedExit(): Promise<number> {
    try {
      process.kill("SIGTERM");
    } catch {
      // The process may have already exited between the guard and kill.
    }
    const terminatedCode = await waitForExit(3_000);
    if (terminatedCode !== null) return terminatedCode;

    try {
      process.kill("SIGKILL");
    } catch {
      // The process may have exited after the timeout.
    }
    const killedCode = await waitForExit(3_000);
    if (killedCode === null) throw new Error("app-server did not exit after SIGKILL");
    return killedCode;
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    process.stdin.end();
    const gracefulCode = await waitForExit(5_000);
    const exitCode = gracefulCode ?? (await forceBoundedExit());
    await Promise.all([stdoutDone, stderrDone]);
    stopped = true;
    rejectPending(new Error("app-server stopped"));
    if (exitCode !== 0) throw new Error(`app-server exited ${exitCode}: ${stderrBuffer.trim()}`);
  }

  async function terminate(): Promise<void> {
    if (stopped) return;
    await forceBoundedExit();
    await Promise.all([stdoutDone, stderrDone]);
    stopped = true;
    rejectPending(new Error("app-server terminated"));
  }

  return { initialize, request, stop, terminate, waitForNotification };
}

type AppServerClient = ReturnType<typeof startClient>;

async function rejectedMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("operation unexpectedly succeeded");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccmux-codex-app-server-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  mkdirSync(codexHome);
  mkdirSync(workspace);
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  const clients: AppServerClient[] = [];

  function createClient(): AppServerClient {
    const client = startClient(codexHome);
    clients.push(client);
    return client;
  }

  try {
    const owner = createClient();
    await owner.initialize();
    const started = ThreadResponseSchema.parse(
      await owner.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    );

    const observer = createClient();
    await observer.initialize();
    const beforeFirstTurn = await rejectedMessage(
      observer.request("thread/resume", { threadId: started.thread.id }),
    );
    if (!beforeFirstTurn.includes("no rollout found")) {
      throw new Error(`unexpected pre-turn resume result: ${beforeFirstTurn}`);
    }

    const turnCompleted = owner.waitForNotification("turn/completed");
    await owner.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Reply exactly PROBE_OK. Do not use tools." }],
    });
    const completed = TurnCompletedSchema.parse(await Promise.race([
      turnCompleted,
      Bun.sleep(60_000).then(() => {
        throw new Error("timed out waiting for synthetic turn completion");
      }),
    ]));
    if (completed.threadId !== started.thread.id || completed.turn.status !== "completed") {
      throw new Error(`synthetic turn ended with status ${completed.turn.status}`);
    }
    const reply = completed.turn.items
      .map((item) => AgentMessageItemSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => result.data.text)
      .join("")
      .trim();
    if (reply !== "PROBE_OK") throw new Error(`unexpected synthetic reply: ${reply}`);

    await Bun.sleep(200);
    const listed = ThreadListResponseSchema.parse(
      await observer.request("thread/list", {
        cwd: workspace,
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
      }),
    );
    const observed = listed.data.find((thread) => thread.id === started.thread.id);
    if (observed?.status.type !== "notLoaded") {
      throw new Error(`observer status was ${observed?.status.type ?? "notListed"}, expected notLoaded`);
    }

    const conflict = await rejectedMessage(
      observer.request("thread/resume", { threadId: started.thread.id }),
    );
    if (!conflict.includes("already has an active writer")) {
      throw new Error(`unexpected writer conflict: ${conflict}`);
    }

    await owner.stop();
    const resumed = ThreadResponseSchema.parse(
      await observer.request("thread/resume", { threadId: started.thread.id }),
    );
    if (resumed.thread.id !== started.thread.id) throw new Error("resume changed thread identity");
    await observer.stop();

    console.log(
      JSON.stringify(
        {
          codexVersion: Bun.spawnSync(["codex", "--version"]).stdout.toString().trim(),
          preTurnResumeRejectedWithoutRollout: true,
          observerStatusWhileOwnedElsewhere: observed.status.type,
          competingResumeRejected: true,
          resumeAfterOwnerExit: true,
          identityPreserved: true,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await Promise.allSettled(clients.reverse().map((client) => client.terminate()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

await main();
