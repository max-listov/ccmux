import type { MachineConfig, Session } from "../../types.ts";
import { SessionSchema } from "../../config/schema.ts";
import { CodexAppThreadContextSchema, readCodexAppThread, prepareManagedCodexTurn,
  startCodexAppTurn } from "./appServer.ts";
import { connectOwnedCodex } from "./ownedRpc.ts";
import type { CodexAppRpc, CodexRpcEvent, CodexRpcRequest } from "./rpc.ts";
import { ownedCodexThreadParams } from "./ownedLaunch.ts";
import { OwnedCodexProjection } from "./ownedProjection.ts";
import { OwnedCodexStatusWriter } from "./ownedStatus.ts";
import { restoreOwnedTurn } from "./ownedObserver.ts";
import { rolloutReadiness } from "./resume.ts";
import { log } from "../../util/log.ts";
import { emitOwnedCodexBoundary } from "./ownedEvents.ts";
import { clearNativeCommand, readNativeCommand, writeNativeReceipt } from "./ownedControl.ts";
import { codexAppMessagePersisted } from "./appPickup.ts";

const OBSERVED_EVENTS = new Set(["thread/status/changed", "turn/started", "turn/completed",
  "item/started", "item/completed", "thread/tokenUsage/updated", "serverRequest/resolved"]);

/** A connection owns its projection and callbacks. A retired connection cannot change a new one. */
export class OwnedCodexConnection {
  private rpc: CodexAppRpc | null = null;
  private projection: OwnedCodexProjection | null = null;
  private buffered: CodexRpcEvent[] = [];
  private bufferedRequests: CodexRpcRequest[] = [];
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
        if (!this.active || !OBSERVED_EVENTS.has(event.method)) return;
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
      onRequest: (request) => {
        if (!this.active) return;
        if (this.projection === null) {
          if (this.bufferedRequests.length >= 16) this.failure = new Error("Native request admission window overflow");
          else this.bufferedRequests.push(request);
        } else if (this.projection.request(request)) this.publish();
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
    const response = CodexAppThreadContextSchema.parse(await rpc.request(fresh ? "thread/start" : "thread/resume", {
      ...ownedCodexThreadParams(this.initial, this.m),
      ...(fresh ? {} : { threadId: this.initial.uuid, excludeTurns: true }),
    }));
    if (!fresh && response.thread.id !== this.initial.uuid) throw new Error("Native resume returned a different thread identity");
    if (this.initial.modelSelection !== undefined && (response.model !== this.initial.modelSelection.model ||
        response.modelProvider !== this.initial.modelSelection.provider))
      throw new Error("Native admission changed the selected provider or model");
    const session = SessionSchema.parse({ ...this.initial, uuid: response.thread.id });
    const projection = new OwnedCodexProjection(this.m, session, this.providerPid);
    this.projection = projection;
    // Events were registered before thread/start or resume. Replay before applying the response;
    // a snapshot that raced a newer event must never overwrite that event.
    for (const event of this.buffered) projection.event(event);
    this.buffered = [];
    for (const request of this.bufferedRequests) projection.request(request);
    this.bufferedRequests = [];
    projection.reconcile(response.thread.status, 0);
    if (fresh) {
      const policy = await prepareManagedCodexTurn(rpc, session, response);
      const deadline = Date.now() + this.m.codexCorrelationTimeoutMs;
      let turnError: unknown = null;
      try {
        await startCodexAppTurn(rpc, session.uuid, this.initial.uuid,
          "Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.", policy);
      } catch (error) {
        turnError = error;
      }
      let rollout = rolloutReadiness(session, this.m);
      while (rollout.status !== "ready" && Date.now() < deadline) {
        signal.throwIfAborted();
        this.liveRpc();
        await Bun.sleep(50);
        rollout = rolloutReadiness(session, this.m);
      }
      if (rollout.status !== "ready") {
        throw new Error(`Native session rollout metadata did not become readable before admission (${rollout.detail}; turn=${String(turnError)})`);
      }
      if (turnError !== null) {
        // A provider can expose the rollout inode before committing session_meta, then reject the
        // first turn while its own thread store is between those two states. Retry only that named
        // pre-dispatch failure, with the same immutable client id, and first rule out a persisted
        // acceptance after a lost response.
        if (!/thread-store.*(?:rollout is empty|session metadata)/i.test(String(turnError))) throw turnError;
        if (!(await codexAppMessagePersisted(this.m, session.uuid, this.initial.uuid))) {
          await startCodexAppTurn(rpc, session.uuid, this.initial.uuid,
            "Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.", policy);
        }
      }
    }
    // A newly created thread has no historical turn to restore. Its bootstrap is already observed
    // on this connection. Asking the experimental history reader here can race native thread-store
    // materialization (some installed stores refuse list_turns before it is available).
    if (!fresh) await restoreOwnedTurn(rpc, projection, session.uuid);
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

  async applyControlResponse(): Promise<void> {
    const command = readNativeCommand(this.m, this.initial.name);
    if (command === null) return;
    const projection = this.projection;
    const rpc = this.liveRpc();
    const reject = async (reason: string) => {
      await writeNativeReceipt(this.m, this.initial.name, { operationId: command.operationId,
        requestId: command.requestId, fingerprint: command.fingerprint, outcome: "rejected", reason });
      clearNativeCommand(this.m, this.initial.name);
    };
    if (projection === null || projection.snapshot().generation !== command.generation) return reject("projection-generation-mismatch");
    const pending = projection.pendingRequest(command.requestId);
    if (pending === null) return reject("request-is-not-pending");
    if (pending.kind !== command.kind) return reject("request-kind-mismatch");
    let result: unknown;
    if (pending.kind === "approval") {
      if (command.decision === null || !pending.decisions.includes(command.decision)) return reject("decision-is-not-available");
      result = { decision: command.decision };
    } else {
      if (command.answers === null) return reject("answers-are-required");
      const expected = pending.questions.map((question) => question.id).sort();
      if (JSON.stringify(Object.keys(command.answers).sort()) !== JSON.stringify(expected)) return reject("question-id-mismatch");
      result = { answers: Object.fromEntries(Object.entries(command.answers).map(([id, answers]) => [id, { answers }])) };
    }
    if (rpc.respond === undefined) return reject("native-response-channel-unavailable");
    await rpc.respond(pending.rpcId, result);
    projection.submitRequest(command.requestId);
    this.publish();
    await writeNativeReceipt(this.m, this.initial.name, { operationId: command.operationId,
      requestId: command.requestId, fingerprint: command.fingerprint, outcome: "submitted", reason: null });
    clearNativeCommand(this.m, this.initial.name);
  }

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
