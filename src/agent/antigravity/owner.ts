import { readFileSync } from 'node:fs';
import type { AgentEngineTurn } from 'stitchkit/agent-executor';
import {
  type AcpConfigOption,
  type AcpDriver,
  type AcpSession,
  createAcpDriver,
} from 'stitchkit/agent-executor/acp';
import type { AgentMessagePart } from 'stitchkit/agent-runtime';
import { resolveMessageAttachments } from '../../attachments/pins.ts';
import { ContentProducer } from '../../content/producer.ts';
import { applyContextCommands, NativeContextPump } from '../../context/pump.ts';
import { withNativeAdmission } from '../../runtime/admission.ts';
import { type RuntimeInput, readRuntimeInput, writeRuntimeInput } from '../../runtime/input.ts';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../runtime/interrupt.ts';
import { answerNativeCommand } from '../../runtime/response.ts';
import { readSelection, seedNativeSelection } from '../../runtime/selection.ts';
import { readRuntimeMode, shouldRestoreMode, writeRuntimeMode } from '../../runtime/sessionMode.ts';
import { ManagedRuntimeStatusWriter } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { HOME } from '../../util/env.ts';
import { writeAntigravityCatalog } from './catalog.ts';
import {
  fromAcpMode,
  preflightAntigravity,
  readAntigravityVersion,
  toAcpMode,
} from './preflight.ts';
import { AntigravityProjection } from './projection.ts';
import { antigravityContextApi } from './transcript.ts';

/**
 * The single-writer owner of one Antigravity ACP session, built on `stitchkit/agent-executor/acp`.
 *
 * All ACP v1 protocol framing, JSON-RPC correlation, turn deltas, permission replies and
 * `session/load` resume live in `stitchkit/agent-executor/acp`. This owner bridges CCMux's
 * durable mailboxes (`input`, `response`, `interrupt`, `permission-mode`, `selection`, `history`)
 * onto that driver without duplicating any ACP transport code.
 */
export class AntigravityOwner {
  private admitted: { content: ContentProducer; projection: AntigravityProjection } | null = null;
  private writer: ManagedRuntimeStatusWriter;
  private driver: AcpDriver | null = null;
  private acpSession: AcpSession | null = null;
  private activeTurn: AgentEngineTurn | null = null;
  private failure: unknown = null;
  private dispatched: string | null = null;
  private lastPublished = 0;
  private lastSequence = -1;
  private resolvedFiles = new Map<string, Uint8Array>();
  private abort = new AbortController();
  private contextPump: NativeContextPump;
  private generation: string;

  constructor(
    private m: MachineConfig,
    private session: Session,
    private report: (error: unknown) => Promise<void>,
    private driverFactory: typeof createAcpDriver = createAcpDriver,
  ) {
    this.generation = session.registrationGeneration ?? crypto.randomUUID();
    this.writer = new ManagedRuntimeStatusWriter(m, session);
    this.contextPump = new NativeContextPump((error) => {
      void this.report(error);
    });
  }

  private get observation() {
    if (!this.admitted) throw new Error('Antigravity content requires an admitted ACP session');
    return this.admitted;
  }

  /** The session after ACP admission — carries the real `nativeSession.id` from `session/new`. */
  get identity(): Session {
    return this.session;
  }

  /** Fatal stream/session error, checked by the supervising loop on every tick. */
  get failed(): unknown {
    return this.failure;
  }

  async open(): Promise<void> {
    if (!this.session.registrationGeneration)
      throw new Error('Antigravity runtime requires a managed registration');
    const executable = preflightAntigravity(this.m, this.session.flags);
    const version = readAntigravityVersion(executable) ?? 'unknown';

    const savedMode = readRuntimeMode(this.m, this.session);
    const desiredMode =
      shouldRestoreMode(savedMode, this.session.registrationGeneration) && savedMode !== null
        ? toAcpMode(savedMode.mode)
        : undefined;
    const savedSelection = readSelection(this.m, this.session)?.options;
    const desiredModel =
      savedSelection?.runtime === 'antigravity'
        ? savedSelection.model.model
        : this.session.modelSelection?.model;
    const desiredEffort =
      savedSelection?.runtime === 'antigravity' ? savedSelection.effort : undefined;

    this.driver = this.driverFactory({
      executable,
      args: ['acp', '--stdio', '--process-per-session', '--sandbox'],
      ...(desiredModel === undefined ? {} : { model: desiredModel }),
      ...(desiredEffort === undefined ? {} : { thoughtLevel: desiredEffort }),
      ...(desiredMode === undefined ? {} : { mode: desiredMode }),
      ...(this.m.antigravityMcpServers === undefined
        ? {}
        : { mcpServers: this.m.antigravityMcpServers }),
      resolveFile: async (reference) => {
        const bytes = this.resolvedFiles.get(reference);
        if (bytes === undefined)
          throw new Error(`Attached image ${reference} is not retained for this turn`);
        return bytes;
      },
      requestTimeoutMs: 45_000,
    });

    const resumedId =
      this.session.nativeSession?.runtime === 'antigravity'
        ? this.session.nativeSession.id
        : undefined;
    const acpSession = await this.driver.open({
      profile: { engine: 'acp', profileId: 'local', home: HOME },
      cwd: this.session.dir,
      ...(resumedId === undefined ? {} : { nativeThreadId: resumedId }),
      signal: this.abort.signal,
    });
    this.acpSession = acpSession;
    if (resumedId !== undefined && acpSession.nativeThreadId !== resumedId)
      throw new Error('Antigravity resumed a different ACP conversation');

    const nativeSession = {
      runtime: 'antigravity' as const,
      id: acpSession.nativeThreadId,
      version,
    };
    const admitted = { ...this.session, nativeSession };
    this.session = admitted;
    const content = new ContentProducer(this.m, admitted, this.generation);
    this.admitted = {
      content,
      projection: new AntigravityProjection(this.m, admitted, content.buffer, this.generation),
    };
    // Clients may read native items immediately on observing ready.
    await content.writer.flushPending();

    await this.syncConfigState(acpSession.configOptions, 'admission', null);
    await this.seedInitialSelection(acpSession.configOptions);

    // ACP has `reconcile: 'none'`, so a dispatch interrupted before `accepted` cannot be safely
    // re-sent automatically: mark it `uncertain` on startup so no duplicate turn is emitted.
    const priorInput = readRuntimeInput(this.m, this.session);
    if (priorInput?.phase === 'dispatching') {
      await writeRuntimeInput(this.m, this.session, { ...priorInput, phase: 'uncertain' });
    }

    this.observation.projection.ready();
    await this.publishNow();
    this.startContextPump();
  }

  async tick(): Promise<void> {
    if (this.failure !== null) throw this.failure;
    await withNativeAdmission(this.m, this.session, async () => {
      await this.applyMode();
      await this.applyResponse();
      await this.applyInterrupt();
      await this.applyInput();
    });
    const snap = this.observation.projection.snapshot();
    if (Date.now() - this.lastPublished >= 1_000 || snap.sequence !== this.lastSequence) {
      this.observation.projection.touch();
      await this.publishNow();
    }
    this.observation.content.publish();
  }

  async close(): Promise<void> {
    this.abort.abort();
    try {
      try {
        await this.contextPump.close();
      } finally {
        await this.acpSession?.close();
      }
    } finally {
      this.acpSession = null;
      this.activeTurn = null;
      this.resolvedFiles.clear();
      if (this.admitted) {
        const { projection, content } = this.admitted;
        this.admitted = null;
        projection.unavailable('stopped');
        await this.writer.write(projection.snapshot()).catch(() => undefined);
        await content.close().catch(() => undefined);
      }
    }
  }

  private async publishNow(): Promise<void> {
    const snap = this.observation.projection.snapshot();
    this.lastPublished = Date.now();
    this.lastSequence = snap.sequence;
    await this.writer.write(snap);
    this.observation.content.publish();
  }

  private startContextPump(): void {
    this.contextPump.start(this.abort.signal, (signal) =>
      applyContextCommands(
        this.m,
        this.session,
        this.generation,
        antigravityContextApi(this.m, this.session),
        signal,
      ),
    );
  }

  private async syncConfigState(
    configOptions: readonly AcpConfigOption[],
    source: 'admission' | 'settings',
    turnId: string | null,
  ): Promise<void> {
    await writeAntigravityCatalog(this.m, this.session, configOptions);
    const modelOpt = configOptions.find((option) => option.category === 'model');
    const effortOpt = configOptions.find((option) => option.category === 'thought_level');
    const modeOpt = configOptions.find((option) => option.category === 'mode');
    if (modelOpt?.currentValue) {
      this.observation.projection.setSelection(
        { provider: 'antigravity', model: modelOpt.currentValue },
        effortOpt?.currentValue,
        source,
        turnId,
      );
    }
    this.observation.projection.setPermissionMode(fromAcpMode(modeOpt?.currentValue));
  }

  private async seedInitialSelection(configOptions: readonly AcpConfigOption[]): Promise<void> {
    const modelOpt = configOptions.find((option) => option.category === 'model');
    const effortOpt = configOptions.find((option) => option.category === 'thought_level');
    const modelId = modelOpt?.currentValue ?? this.session.modelSelection?.model;
    if (!modelId) return;
    await seedNativeSelection(this.m, this.session, {
      runtime: 'antigravity',
      model: { provider: 'antigravity', model: modelId },
      ...(effortOpt?.currentValue ? { effort: effortOpt.currentValue } : {}),
    });
  }

  private async applyMode(): Promise<void> {
    const session = this.acpSession;
    if (!session || this.activeTurn !== null) return;
    const request = readRuntimeMode(this.m, this.session);
    if (request === null || request.phase !== 'queued') return;
    if (request.generation !== this.session.registrationGeneration) return;
    try {
      const updated = await session.setConfigOption('mode', toAcpMode(request.mode));
      await this.syncConfigState(updated, 'settings', null);
      this.observation.projection.setPermissionMode(request.mode);
      await writeRuntimeMode(this.m, this.session, { ...request, phase: 'complete', reason: null });
      await this.publishNow();
    } catch (error) {
      await writeRuntimeMode(this.m, this.session, {
        ...request,
        phase: 'failed',
        reason: 'The runtime refused this permission mode',
      });
      await this.report(error);
    }
  }

  private async applyResponse(): Promise<void> {
    await answerNativeCommand(this.m, this.session.name, {
      generation: this.generation,
      pending: (requestId) => this.observation.projection.pendingRequest(requestId),
      submit: async (command) => {
        const turn = this.activeTurn;
        if (turn === null || command.decision === null)
          throw new Error('Validated approval disappeared');
        const reply =
          command.decision === 'accept' || command.decision === 'acceptForSession'
            ? ({ kind: 'approve' } as const)
            : ({ kind: 'deny', message: 'Denied by operator' } as const);
        await turn.respond(command.requestId, reply);
        this.observation.projection.resolvePending(command.requestId, command.decision);
        await this.publishNow();
      },
    });
  }

  private async applyInterrupt(): Promise<void> {
    const command = readRuntimeInterrupt(this.m, this.session);
    if (command === null || !['queued', 'uncertain'].includes(command.phase)) return;
    const cancellable = () =>
      isCancellableTurn(this.observation.projection.snapshot(), command.generation, command.turnId);
    if (!cancellable() || this.activeTurn === null) {
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      return;
    }
    await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'uncertain' });
    if (!cancellable() || this.activeTurn === null) {
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      return;
    }
    try {
      await this.activeTurn.interrupt();
    } catch (error) {
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      await this.report(error);
      return;
    }
    await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'accepted' });
    await this.publishNow();
  }

  private async applySelectionForTurn(input: RuntimeInput): Promise<void> {
    const session = this.acpSession;
    if (!session) return;
    const desired = input.turnOptions?.options ?? readSelection(this.m, this.session)?.options;
    if (desired?.runtime !== 'antigravity') return;
    let currentOptions = session.configOptions;
    const currentModel = currentOptions.find((o) => o.category === 'model')?.currentValue;
    if (desired.model.model !== currentModel) {
      currentOptions = await session.setConfigOption('model', desired.model.model);
    }
    const currentEffort = currentOptions.find((o) => o.category === 'thought_level')?.currentValue;
    if (desired.effort !== undefined && desired.effort !== currentEffort) {
      currentOptions = await session.setConfigOption('thought_level', desired.effort);
    }
    await this.syncConfigState(currentOptions, 'settings', input.nativeId);
  }

  private async buildTurnParts(input: RuntimeInput): Promise<AgentMessagePart[]> {
    this.resolvedFiles.clear();
    const parts: AgentMessagePart[] = [{ type: 'text', text: input.text }];
    const references = input.images ?? [];
    if (references.length === 0) return parts;
    const resolved = await resolveMessageAttachments(
      this.m,
      this.session,
      input.messageId,
      references,
      AbortSignal.timeout(10_000),
    );
    if (resolved.length !== references.length)
      throw new Error(
        `Attached images are not retained: ${references.length} sent, ${resolved.length} resolved`,
      );
    for (const item of resolved) {
      this.resolvedFiles.set(item.reference.id, new Uint8Array(readFileSync(item.path)));
      parts.push({
        type: 'file',
        reference: item.reference.id,
        mediaType: item.reference.mediaType,
      });
    }
    return parts;
  }

  private async applyInput(): Promise<void> {
    const session = this.acpSession;
    if (!session || this.activeTurn !== null) return;
    const input = readRuntimeInput(this.m, this.session);
    if (input?.phase !== 'queued' || input.nativeId === this.dispatched) return;
    if (this.observation.projection.snapshot().state !== 'idle') return;

    this.dispatched = input.nativeId;
    const startedAt = new Date().toISOString();
    await this.applySelectionForTurn(input);
    const parts = await this.buildTurnParts(input);

    await writeRuntimeInput(this.m, this.session, {
      ...input,
      phase: 'dispatching',
      dispatchedAt: startedAt,
    });
    this.observation.projection.startTurn(input.nativeId, startedAt);
    await this.publishNow();

    const turn = await session.startTurn({
      turnId: input.nativeId,
      clientId: input.messageId,
      input: parts,
    });
    this.activeTurn = turn;
    await writeRuntimeInput(this.m, this.session, {
      ...input,
      phase: 'accepted',
      turnId: input.nativeId,
    });
    void this.drainTurn(turn, input.nativeId);
  }

  private async drainTurn(turn: AgentEngineTurn, turnId: string): Promise<void> {
    let sawTerminal = false;
    try {
      for await (const delta of turn.deltas) {
        if (this.abort.signal.aborted) return;
        if (delta.type === 'turn-end') sawTerminal = true;
        this.observation.projection.applyDelta(delta);
        await this.publishNow();
      }
      if (!sawTerminal && !this.abort.signal.aborted) {
        this.observation.projection.failTurn(turnId, 'failed');
        await this.publishNow();
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      if (!sawTerminal) {
        this.observation.projection.failTurn(turnId, 'failed');
        await this.publishNow().catch(() => undefined);
      }
      this.failure = error;
      await this.report(error);
    } finally {
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
      this.resolvedFiles.clear();
      if (this.acpSession && !this.abort.signal.aborted) {
        await this.syncConfigState(this.acpSession.configOptions, 'settings', turnId).catch(
          () => undefined,
        );
      }
    }
  }
}
