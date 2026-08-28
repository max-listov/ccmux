import { dirname } from "node:path";
import net from "node:net";
import type { MachineConfig, Session } from "../../types.ts";
import { launchEnv } from "./launch.ts";
import { ownedCodexArgv, ownedCodexClientArgv } from "./ownedLaunch.ts";
import { ownedCodexSocket, privateRuntimeDirectory } from "./ownedPaths.ts";
import { OwnedCodexConnection } from "./ownedConnection.ts";
import { historyFile } from "./resume.ts";
import { withDirectoryLock } from "../../config/registryLock.ts";
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from "../../chat/auth.ts";
import { writeLaunchStamp } from "../sessionStatus.ts";
import { computeStamp } from "../launchStamp.ts";
import { promptInvocation } from "../../env.ts";
import { log } from "../../util/log.ts";
import { loadSessions } from "../../config/sessions.ts";
import { ownedChildAlive, stopOwnedChildGroup } from "./ownedChild.ts";

type Process = ReturnType<typeof Bun.spawn>;
/** Admission failures block; a crashed, already admitted provider can resume its exact identity. */
export class OwnedCodexRuntimeExit extends Error {}

async function stopProcess(proc: Process): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2_000);
  try { await proc.exited; } finally { clearTimeout(timer); }
}

async function socketOccupied(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const finish = (occupied: boolean) => { clearTimeout(timer); socket.destroy(); resolve(occupied); };
    const timer = setTimeout(() => finish(true), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(!("code" in error && ["ENOENT", "ECONNREFUSED"].includes(String(error.code)))));
  });
}

/** One native server per session; the provider's own OS writer lock also guards its UUID. */
export async function runOwnedCodexProcess(m: MachineConfig, initial: Session,
  promote?: (uuid: string) => Promise<Session>): Promise<void> {
  const socket = ownedCodexSocket(m, initial.name);
  privateRuntimeDirectory(dirname(socket));
  await withDirectoryLock(`${socket}.owner`, async () => {
    // Never attach to an orphan or another supervisor by accidentally reusing its endpoint.
    if (await socketOccupied(socket)) throw new Error("Native runtime endpoint already has an owner");
    if (promote === undefined && historyFile(initial, m) === null) throw new Error("Native resume history is missing; refusing to create another conversation");
    await run(m, initial, promote);
  }, "native Codex runtime");
}

async function run(m: MachineConfig, initial: Session, promote?: (uuid: string) => Promise<Session>): Promise<void> {
  const env = launchEnv(m, initial);
  env[CHAT_CREDENTIAL_ENV] = rotateChatCredential(m, initial);
  const abort = new AbortController();
  let stopping = false;
  const stop = () => { stopping = true; abort.abort(); };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.once(signal, stop);
  let server: Process | null = null;
  let client: Process | null = null;
  let connection: OwnedCodexConnection | null = null;
  let admitted = false;
  let stderrTail = "";
  let drain: Promise<void> = Promise.resolve();
  try {
    const child = Bun.spawn(ownedCodexArgv(initial, m), { cwd: initial.dir, env, detached: true,
      stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    server = child;
    void child.exited.then(() => abort.abort());
    drain = (async () => {
      for await (const bytes of child.stderr) stderrTail = (stderrTail + Buffer.from(bytes).toString()).slice(-8_192);
    })();
    const deadline = Date.now() + m.codexCorrelationTimeoutMs;
    while (!abort.signal.aborted) {
      const candidate = new OwnedCodexConnection(m, initial, child.pid);
      try { await candidate.open(abort.signal); connection = candidate; break; }
      catch (error) {
        await candidate.close("starting");
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(100);
      }
    }
    if (connection === null) throw new Error("Native App Server exited before admission");
    let session = await connection.admit(promote !== undefined, abort.signal);
    if (child.exitCode !== null) throw new Error("Native App Server exited during admission");
    if (promote !== undefined) session = await promote(session.uuid);
    admitted = true;
    connection.activateEvents(session);
    writeLaunchStamp(session.name, computeStamp(session, m, promptInvocation()));
    let reconnectAt = 0;
    let reconnectDelay = 500;
    let clientAt = 0;
    while (!abort.signal.aborted) {
      // Some launchers leave a native grandchild holding stderr after their own death, so the
      // process exit promise alone is not a sufficient crash detector.
      if (!ownedChildAlive(child.pid)) throw new OwnedCodexRuntimeExit("Native provider launcher exited");
      if ((client === null || client.exitCode !== null) && Date.now() >= clientAt) {
        client = Bun.spawn(ownedCodexClientArgv(session, m), { cwd: session.dir, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        clientAt = Date.now() + 5_000;
      }
      if (Date.now() >= reconnectAt) {
        const current = loadSessions(m).find((row) => row.name === session.name);
        if (current?.uuid !== session.uuid || current.runtime !== session.runtime || current.registrationGeneration !== session.registrationGeneration) {
          throw new Error("Managed identity changed while the native runtime was alive");
        }
        try {
          if (connection === null) {
            const candidate = new OwnedCodexConnection(m, session, child.pid);
            connection = candidate;
            await candidate.open(abort.signal);
            await candidate.admit(false, abort.signal);
            candidate.activateEvents(session);
          } else await connection.refresh(session);
          reconnectDelay = 500;
        } catch (error) {
          if (!abort.signal.aborted) log.warn({ msg: "native observer reconnecting", name: session.name, error: String(error) });
          await connection?.close("disconnected").catch((error: unknown) => log.error({ msg: "native disconnect publication failed", error: String(error) }));
          connection = null;
          reconnectAt = Date.now() + reconnectDelay;
          reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
        }
      }
      await Bun.sleep(500);
    }
    if (!stopping) throw new OwnedCodexRuntimeExit("Native App Server exited after admission");
  } catch (error) {
    if (stopping) return;
    log.error({ msg: "owned Codex runtime failure", name: initial.name, error: String(error), stderr: stderrTail });
    if (admitted && server?.exitCode !== null) throw new OwnedCodexRuntimeExit(String(error));
    throw error;
  } finally {
    abort.abort();
    await connection?.close("stopped").catch((error: unknown) => log.error({ msg: "native stop publication failed", error: String(error) }));
    if (client !== null) await stopProcess(client);
    if (server !== null) await stopOwnedChildGroup(server);
    await drain;
    for (const signal of signals) process.removeListener(signal, stop);
  }
}
