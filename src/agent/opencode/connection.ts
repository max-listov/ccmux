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

const HistorySchema = z.array(z.object({ info: OpenCodeMessageSchema, parts: z.array(OpenCodePartSchema).max(256) })).max(64);

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
  constructor(private m: MachineConfig, private session: Session, private server: OpenCodeServer) {
    this.projection = new OpenCodeProjection(m, session, server.child.pid, error => {
      this.diagnostic = this.diagnostic.then(() => recordRuntimeDiagnostic(m, session.name, "native-outcome", error));
    });
    this.writer = new ManagedRuntimeStatusWriter(m, session);
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
          } else { this.projection.event(event); await this.publish(); }
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
    const history = HistorySchema.parse((await this.server.client.session.messages({ sessionID, limit: 64 }, { signal: readSignal })).data);
    for (const message of history) {
      this.projection.message(message.info, false);
      for (const part of message.parts) this.projection.part(part);
      this.projection.message(message.info);
    }
    for (const request of z.array(z.unknown()).max(128).parse((await this.server.client.permission.list(undefined, { signal: readSignal })).data)) this.projection.permission(request);
    for (const request of z.array(z.unknown()).max(128).parse((await this.server.client.question.list(undefined, { signal: readSignal })).data)) this.projection.question(request);
    this.emittedSequence = this.projection.snapshot().sequence;
    for (const event of this.buffered) this.projection.event(event);
    this.buffered = []; this.bufferedBytes = 0; this.admitting = false;
    await this.refresh(readSignal);
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
  async close(reason: string): Promise<void> {
    this.abort.abort();
    await this.stream;
    this.projection.unavailable(reason);
    await this.writer.write(this.projection.snapshot());
    await this.diagnostic;
  }
}
