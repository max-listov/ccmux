import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import { ManagedRuntimeStatusWriter } from "../../runtime/status.ts";
import { readRuntimeInterrupt, writeRuntimeInterrupt } from "../../runtime/interrupt.ts";
import { OpenCodeProjection } from "./projection.ts";
import { OpenCodeMessageSchema, OpenCodePartSchema, OpenCodeStatusSchema } from "./protocol.ts";
import type { OpenCodeServer } from "./server.ts";
import { applyOpenCodeInput } from "./input.ts";
import { applyOpenCodeResponse } from "./responses.ts";
import { prepareOpenCodeCatalog } from "./catalog.ts";
import { emitRuntimeBoundaries } from "../../runtime/events.ts";
import { recordRuntimeDiagnostic } from "../../runtime/diagnostics.ts";
import { ContentProducer } from "../../content/producer.ts";
import { OpenCodeContentObserver } from "../../content/opencode.ts";
import { applyContextCommands, observeContextCompletion, NativeContextPump } from "../../context/pump.ts";
import { openCodeContextApi } from "../../context/opencode.ts";

const MessageSchema = z.object({ info: OpenCodeMessageSchema, parts: z.array(OpenCodePartSchema).max(256) });
const HistorySchema = z.array(MessageSchema).max(1);

export class OpenCodeConnection {
  readonly projection: OpenCodeProjection;
  private writer: ManagedRuntimeStatusWriter;
  private abort = new AbortController();
  private stream: Promise<void> | null = null;
  private failure: unknown = null;
  private admitting = true;
  private buffered: unknown[] = [];
  private bufferedBytes = 0;
  private emittedSequence = 0;
  private diagnostic = Promise.resolve();
  private content: ContentProducer;
  private contentObserver: OpenCodeContentObserver;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private contextCompletionSeen = 0;
  private contextCompletionApplied = 0;
  private contextPump: NativeContextPump;
  constructor(private m: MachineConfig, private session: Session, private server: OpenCodeServer) {
    this.projection = new OpenCodeProjection(m, session, server.child.pid, error => {
      this.diagnostic = this.diagnostic.then(() => recordRuntimeDiagnostic(m, session.name, "native-outcome", error));
    });
    this.writer = new ManagedRuntimeStatusWriter(m, session);
    this.content = new ContentProducer(m, session, this.projection.snapshot().generation);
    this.contentObserver = new OpenCodeContentObserver(this.content.buffer, session.nativeSession?.id ?? "");
    this.contextPump = new NativeContextPump(error => {
      this.diagnostic = this.diagnostic.then(() => recordRuntimeDiagnostic(m, session.name, "native-context", error));
    });
  }
  async open(signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.abort.signal]);
    const { stream } = await this.server.client.event.subscribe(undefined, { signal: combined, sseMaxRetryAttempts: 1 });
    this.stream = (async () => {
      try {
        for await (const event of stream) {
          if (this.admitting) {
            this.bufferedBytes += Buffer.byteLength(JSON.stringify(event));
            if (this.buffered.length >= 128 || this.bufferedBytes > 512 * 1024) throw new Error("Native admission event window exceeded");
            this.buffered.push(event);
          } else {
            this.projection.event(event); this.contentObserver.event(event); this.content.publish(); this.queuePublish();
            if (event.type === "session.compacted" && event.properties.sessionID === this.session.nativeSession?.id) {
              this.contextCompletionSeen++;
            }
          }
        }
        if (!combined.aborted) throw new Error("Native event stream ended");
      } catch (error) {
        this.failure = error; this.projection.unavailable("disconnected");
        await this.writer.write(this.projection.snapshot());
      }
    })();
    const sessionID = this.session.nativeSession?.id;
    if (!sessionID) throw new Error("Native continuation is missing");
    const readSignal = AbortSignal.any([combined, AbortSignal.timeout(5_000)]);
    await prepareOpenCodeCatalog(this.m, this.session, this.server.client, readSignal);
    // Recovery observes only the current turn. Reading the whole conversation would repeat all
    // retained images and make startup cost depend on lifetime history. History has its own API.
    const history = HistorySchema.parse((await this.server.client.session.messages({ sessionID, limit: 1 }, { signal: readSignal })).data);
    const last = history[0];
    if (last?.info.role === "assistant" && last.info.parentID) {
      const parent = MessageSchema.parse((await this.server.client.session.message({ sessionID, messageID: last.info.parentID }, { signal: readSignal })).data);
      if (parent.info.role !== "user" || parent.info.id !== last.info.parentID || parent.info.sessionID !== sessionID)
        throw new Error("Native recovery parent identity differs");
      history.unshift(parent);
    }
    for (const message of history) {
      this.projection.message(message.info, false);
      this.contentObserver.message(message.info);
      for (const part of message.parts) { this.projection.part(part); this.contentObserver.part(part); }
      this.projection.message(message.info);
    }
    for (const request of z.array(z.unknown()).max(128).parse((await this.server.client.permission.list(undefined, { signal: readSignal })).data)) this.projection.permission(request);
    for (const request of z.array(z.unknown()).max(128).parse((await this.server.client.question.list(undefined, { signal: readSignal })).data)) this.projection.question(request);
    this.emittedSequence = this.projection.snapshot().sequence;
    for (const event of this.buffered) { this.projection.event(event); this.contentObserver.event(event); }
    this.buffered = []; this.bufferedBytes = 0; this.admitting = false;
    this.content.publish();
    await this.refresh(readSignal);
  }
  private queuePublish(): void {
    this.publishTimer ??= setTimeout(() => {
      this.publishTimer = null;
      void this.publish().catch(error => { this.failure = error; });
    }, 50);
  }
  private async publish(): Promise<void> {
    await this.diagnostic;
    const snapshot = this.projection.snapshot();
    emitRuntimeBoundaries(this.m, this.session, snapshot, this.emittedSequence);
    this.emittedSequence = snapshot.sequence;
    await this.writer.write(snapshot);
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    if (this.failure !== null) throw this.failure;
    const revision = this.projection.revision;
    const statuses = z.record(z.string(), OpenCodeStatusSchema).parse((await this.server.client.session.status(undefined, { signal })).data);
    this.projection.status(statuses[this.session.nativeSession?.id ?? ""] ?? { type: "idle" }, revision);
    await this.publish();
  }
  async tick(signal: AbortSignal): Promise<void> {
    if (this.failure !== null) throw this.failure;
    await this.refresh(signal);
    this.contextPump.start(AbortSignal.any([signal, this.abort.signal]), async contextSignal => {
      const api = openCodeContextApi(this.m, this.session, this.server.client), generation = this.projection.snapshot().generation;
      const completion = this.contextCompletionSeen;
      if (completion !== this.contextCompletionApplied) {
        const marker = await api.compactionMarker(AbortSignal.any([contextSignal, AbortSignal.timeout(5_000)]));
        if (marker === null) throw new Error("Completed native context marker is unavailable");
        await observeContextCompletion(this.m, this.session, generation, marker, () => this.publishContextBoundary());
        this.contextCompletionApplied = completion;
      }
      await applyContextCommands(this.m, this.session, generation, api, contextSignal, () => this.publishContextBoundary());
    });
    await applyOpenCodeResponse(this.m, this.session, this.server.client, this.projection, signal);
    const interrupt = readRuntimeInterrupt(this.m, this.session);
    if (interrupt?.phase === "queued") {
      const snapshot = this.projection.snapshot();
      const valid = interrupt.generation === snapshot.generation && interrupt.turnId === snapshot.turn?.id &&
        snapshot.turn.status === "inProgress" && snapshot.state === "working";
      await writeRuntimeInterrupt(this.m, this.session, { ...interrupt, phase: valid ? "uncertain" : "rejected" });
      if (valid && this.session.nativeSession) {
        await this.server.client.session.abort({ sessionID: this.session.nativeSession.id }, { signal });
        await writeRuntimeInterrupt(this.m, this.session, { ...interrupt, phase: "accepted" });
      }
    }
    await applyOpenCodeInput(this.m, this.session, this.server.client, this.projection, signal);
    await this.publish();
  }
  private async publishContextBoundary(): Promise<void> {
    this.content.buffer.resetContext(); this.content.publish();
    await this.content.writer.flushPending();
  }
  async close(reason: string): Promise<void> {
    this.abort.abort();
    await this.contextPump.close();
    await this.stream;
    if (this.publishTimer !== null) { clearTimeout(this.publishTimer); this.publishTimer = null; }
    this.projection.unavailable(reason);
    await this.writer.write(this.projection.snapshot());
    await this.diagnostic;
    await this.content.close();
  }
}
