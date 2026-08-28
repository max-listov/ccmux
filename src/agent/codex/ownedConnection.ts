import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import { SessionSchema } from "../../config/schema.ts";
import { ThreadSchema, readCodexAppThread, startCodexAppTurn } from "./appServer.ts";
import { connectOwnedCodex } from "./ownedRpc.ts";
import type { CodexAppRpc, CodexRpcEvent } from "./rpc.ts";
import { ownedCodexThreadParams } from "./ownedLaunch.ts";
import { OwnedCodexProjection } from "./ownedProjection.ts";
import { OwnedCodexStatusWriter } from "./ownedStatus.ts";
import { restoreOwnedTurn } from "./ownedObserver.ts";
import { historyFile } from "./resume.ts";
import { log } from "../../util/log.ts";
import { emitOwnedCodexBoundary } from "./ownedEvents.ts";

/** A connection owns its projection and callbacks. A retired connection cannot change a new one. */
export class OwnedCodexConnection {
  private rpc: CodexAppRpc | null = null;
  private projection: OwnedCodexProjection | null = null;
  private buffered: CodexRpcEvent[] = [];
  private active = true;
  private failure: Error | null = null;
  private feedSession: Session | null = null;
  readonly writer: OwnedCodexStatusWriter;

  constructor(private m: MachineConfig, private initial: Session, private providerPid: number) {
    this.writer = new OwnedCodexStatusWriter(m, initial.name);
  }

  async open(signal: AbortSignal): Promise<void> {
    this.rpc = await connectOwnedCodex(this.m, this.initial, {
      signal,
      onEvent: (event) => {
        if (!this.active || !["thread/status/changed", "turn/started", "turn/completed"].includes(event.method)) return;
        if (this.projection === null) {
          if (this.buffered.length >= 128) this.failure = new Error("Native admission event window overflow");
          else this.buffered.push(event);
        } else if (this.projection.event(event)) {
          this.publish();
          if (this.feedSession !== null && event.method !== "thread/status/changed") {
            emitOwnedCodexBoundary(this.m, this.feedSession, this.projection.snapshot());
          }
        }
      },
      onClose: (error) => {
        if (!this.active) return;
        this.failure = error;
        this.projection?.unavailable("disconnected");
        this.publish();
      },
    });
  }

  async admit(fresh: boolean, signal: AbortSignal): Promise<Session> {
    const rpc = this.liveRpc();
    const response = z.object({ thread: ThreadSchema }).parse(await rpc.request(fresh ? "thread/start" : "thread/resume", {
      ...ownedCodexThreadParams(this.initial, this.m),
      ...(fresh ? {} : { threadId: this.initial.uuid, excludeTurns: true }),
    }));
    if (!fresh && response.thread.id !== this.initial.uuid) throw new Error("Native resume returned a different thread identity");
    const session = SessionSchema.parse({ ...this.initial, uuid: response.thread.id });
    const projection = new OwnedCodexProjection(this.m, session, this.providerPid);
    this.projection = projection;
    // Events were registered before thread/start or resume. Replay before applying the response;
    // a snapshot that raced a newer event must never overwrite that event.
    for (const event of this.buffered) projection.event(event);
    this.buffered = [];
    projection.reconcile(response.thread.status, 0);
    if (fresh) {
      await startCodexAppTurn(rpc, session.uuid, this.initial.uuid,
        "Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.");
      const deadline = Date.now() + this.m.codexCorrelationTimeoutMs;
      while (historyFile(session, this.m) === null && Date.now() < deadline) {
        signal.throwIfAborted();
        this.liveRpc();
        await Bun.sleep(50);
      }
      if (historyFile(session, this.m) === null) throw new Error("Native session did not persist its conversation before admission");
    }
    await restoreOwnedTurn(rpc, projection, session.uuid);
    await this.refresh(session);
    return session;
  }

  async refresh(session: Session): Promise<void> {
    const rpc = this.liveRpc();
    const projection = this.projection;
    if (projection === null) throw new Error("Native connection has not been admitted");
    const revision = projection.revision;
    const thread = await readCodexAppThread(rpc, session.uuid);
    this.liveRpc();
    projection.reconcile(thread.status, revision);
    await this.writer.write(projection.snapshot());
  }

  activateEvents(session: Session): void { this.feedSession = session; }

  async close(reason: string): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.rpc?.close();
    this.rpc = null;
    if (this.projection !== null) {
      this.projection.unavailable(reason);
      await this.writer.write(this.projection.snapshot());
    }
  }

  private liveRpc(): CodexAppRpc {
    if (this.failure !== null) throw this.failure;
    if (!this.active || this.rpc === null) throw new Error("Native connection is closed");
    return this.rpc;
  }

  private publish(): void {
    if (this.projection === null) return;
    void this.writer.write(this.projection.snapshot()).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      log.error({ msg: "native state publication failed", name: this.initial.name, error: String(error) });
    });
  }
}
