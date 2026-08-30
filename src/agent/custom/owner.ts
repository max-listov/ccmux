import type { AgentLanguageModelProvider } from 'stitchkit/agent-runtime';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../../chat/auth.ts';
import { ContentProducer } from '../../content/producer.ts';
import { applyContextCommands, NativeContextPump } from '../../context/pump.ts';
import { withNativeAdmission } from '../../runtime/admission.ts';
import { readRuntimeInput, writeRuntimeInput } from '../../runtime/input.ts';
import { type OwnedRuntimeJournal, openOwnedRuntimeJournal } from '../../runtime/journalOwner.ts';
import { readSelection } from '../../runtime/selection.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { CustomChronology } from './chronology.ts';
import { applyCustomInterrupt, applyCustomResponse } from './commands.ts';
import { CustomCorrelation } from './correlation.ts';
import { openCustomEngine } from './engine.ts';
import { customContextApi } from './history.ts';
import { customModel, prepareCustomHost } from './host.ts';
import { customImageResolver } from './images.ts';
import { customInputParts } from './input.ts';
import { CustomProfile } from './profile.ts';
import { CustomProjection } from './projection.ts';

type Engine = Awaited<ReturnType<typeof openCustomEngine>>;

/** One supervisor-owned Harness. The existing mailbox admits work; SQLite owns execution.
 * Client disconnects never close this owner. No model/history work happens on status reads. */
export class CustomOwner {
  readonly content: ContentProducer;
  readonly projection: CustomProjection;
  private writer: ManagedRuntimeStatusWriter;
  private engine: Engine | null = null;
  private dirty = true;
  private failure: unknown = null;
  private held = false;
  private journal: OwnedRuntimeJournal | null = null;
  private chronology: CustomChronology | undefined;
  private abort = new AbortController();
  private contextPump = new NativeContextPump((error) => {
    this.failure = error;
  });
  private correlation: CustomCorrelation | null = null;
  private get evidence(): CustomCorrelation {
    if (!this.correlation) throw new Error('Custom correlation is unavailable');
    return this.correlation;
  }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPublished = 0;
  private lastSequence = -1;
  constructor(
    private m: MachineConfig,
    private session: Session,
    private report: (error: unknown) => Promise<void>,
  ) {
    const generation = crypto.randomUUID();
    this.content = new ContentProducer(m, session, generation);
    this.projection = new CustomProjection(m, session, this.content.buffer, generation);
    this.writer = new ManagedRuntimeStatusWriter(m, session);
  }
  private get runtime(): Engine {
    if (!this.engine) throw new Error('Custom owner is not open');
    return this.engine;
  }
  private get conversationId(): string {
    if (this.session.nativeSession?.runtime !== 'custom')
      throw new Error('Custom identity is absent');
    return this.session.nativeSession.id;
  }
  async open(provider?: AgentLanguageModelProvider): Promise<void> {
    if (!this.session.registrationGeneration) throw new Error('Custom registration is absent');
    this.journal = await openOwnedRuntimeJournal(this.m, {
      kind: 'worker',
      registration: this.session.registrationGeneration,
    });
    this.chronology = new CustomChronology(this.journal, this.session.registrationGeneration);
    this.journal.submit({
      at: new Date().toISOString(),
      runtime: 'custom',
      kind: this.journal.recovered ? 'recovery' : 'started',
      registration: this.session.registrationGeneration,
    });
    const host = prepareCustomHost(this.m, this.session);
    const profile = new CustomProfile(managedRuntimeRoot(this.m, this.session), this.session, host);
    this.engine = await openCustomEngine({
      root: managedRuntimeRoot(this.m, this.session),
      session: this.session,
      host,
      diagnose: this.report,
      onProfile: async (event) => {
        this.projection.profile(await profile.applied(event));
        this.queuePublish();
      },
      resolveFile: customImageResolver(this.m, this.session),
      commandIdentity: {
        ...Object.fromEntries(
          ['CCMUX_CONFIG', 'CCMUX_CACHE_DIR', 'CCMUX_DATA_DIR'].flatMap((name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]]],
          ),
        ),
        CCMUX_STATE_DIR: this.m.stateDir,
        CCMUX_SESSION: this.session.name,
        [CHAT_CREDENTIAL_ENV]: rotateChatCredential(this.m, this.session),
      },
      ...(provider === undefined ? {} : { provider }),
      publish: (event) => {
        this.projection.event(event);
        this.chronology?.event(event);
        this.chronology?.snapshot(this.projection.snapshot());
        if (
          ['admission', 'terminal', 'run-state'].includes(event.type) ||
          this.projection.snapshot().reason === 'native-resync-required'
        )
          this.dirty = true;
        this.content.publish();
        this.queuePublish();
      },
      onError: async (error) => {
        this.failure = error;
        await this.report(error);
      },
    });
    this.correlation = new CustomCorrelation(this.m, this.session, this.runtime, this.projection);
    const retainedProfile = await profile.read(this.runtime);
    if (retainedProfile) this.projection.profile(retainedProfile);
    const recovered = await this.runtime.harness.recover({
      resolveContext: ({ conversationId }) => {
        if (conversationId !== this.conversationId) throw new Error('Recovery identity differs');
        return this.runtime.context;
      },
      decide: ({ run }) => (run.state === 'queued' ? { action: 'resume' } : { action: 'skip' }),
      pageSize: 16,
      maxRuns: 32,
    });
    for (const recovery of recovered) {
      if (recovery.outcome === 'failed') throw recovery.error;
      if (recovery.outcome === 'skipped') this.held = true;
      if (recovery.result) this.observeResult(recovery.result);
    }
    await this.tick();
  }
  private observeResult(result: Promise<unknown>): void {
    void result.then(
      () => {
        this.dirty = true;
      },
      async (error) => {
        this.failure = error;
        await this.report(error);
      },
    );
  }
  private queuePublish(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.lastPublished = Date.now();
      this.lastSequence = this.projection.snapshot().sequence;
      void this.writer.write(this.projection.snapshot()).catch((error) => {
        this.failure = error;
      });
    }, 50);
  }

  private async input(): Promise<void> {
    let input = readRuntimeInput(this.m, this.session);
    if (!input) {
      if (this.projection.snapshot().reason === 'starting') this.projection.ready();
      return;
    }
    if (this.dirty || input.phase === 'dispatching' || input.phase === 'uncertain') {
      this.dirty = false;
      input = await this.evidence.reconcile(input);
    }
    if (input.phase === 'accepted' || this.held) return;
    if (this.projection.snapshot().state !== 'idle') return;
    const host = prepareCustomHost(this.m, this.session);
    const accepted = input.turnOptions ?? readSelection(this.m, this.session);
    const options = accepted?.options;
    if (options?.runtime !== 'custom')
      throw new Error('Custom input selection or modality is unavailable');
    const selected = customModel(host.config, options.model);
    if ((input.images?.length ?? 0) > 0 && !selected.capabilities.includes('vision'))
      throw new Error('Custom model does not support image input');
    const model = selected.selection;
    if (!accepted) throw new Error('Custom accepted selection is absent');
    input = { ...input, turnOptions: accepted };
    await writeRuntimeInput(this.m, this.session, { ...input, phase: 'dispatching' });
    const ticket = this.runtime.harness.submit({
      conversationId: this.conversationId,
      idempotencyKey: input.messageId,
      recordIds: {
        inputMessageId: `input:${input.messageId}`,
        runId: input.nativeId,
        assistantMessageId: `assistant:${input.messageId}`,
      },
      context: this.runtime.context,
      parts: customInputParts(input),
      metadata: {
        registration: this.session.registrationGeneration,
        messageId: input.messageId,
        recipeDigest: this.session.launchRecipe?.digest,
        model,
        images: input.images ?? [],
      },
    });
    this.observeResult(ticket.result);
    const admission = await ticket.admission;
    if (
      admission.runId !== input.nativeId ||
      admission.inputMessageId !== `input:${input.messageId}`
    )
      throw new Error('Native admission changed its requested identity');
    await writeRuntimeInput(this.m, this.session, { ...input, phase: 'accepted' });
    this.dirty = true;
  }

  async tick(): Promise<void> {
    if (this.failure !== null) throw this.failure;
    await withNativeAdmission(this.m, this.session, async () => {
      await this.input();
      const control = {
        m: this.m,
        session: this.session,
        runtime: this.runtime,
        projection: this.projection,
        correlation: this.evidence,
        ...(this.chronology ? { chronology: this.chronology } : {}),
        observeResult: (result: Promise<unknown>) => this.observeResult(result),
        changed: () => {
          this.dirty = true;
        },
      };
      await applyCustomResponse(control);
      await applyCustomInterrupt(control);
      if (this.held) this.projection.unavailable('prior-owner-execution-unresolved');
      this.chronology?.snapshot(this.projection.snapshot());
    });
    if (
      Date.now() - this.lastPublished >= 1000 ||
      this.projection.snapshot().sequence !== this.lastSequence
    ) {
      this.lastPublished = Date.now();
      this.projection.touch();
      this.lastSequence = this.projection.snapshot().sequence;
      await this.writer.write(this.projection.snapshot());
    }
    this.content.publish();
    await this.journal?.publishStatus();
    this.contextPump.start(this.abort.signal, (signal) =>
      applyContextCommands(
        this.m,
        this.session,
        this.projection.snapshot().generation,
        customContextApi(this.m, this.session, this.runtime),
        signal,
      ),
    );
  }
  async close(): Promise<void> {
    this.abort.abort();
    try {
      try {
        await this.contextPump.close();
      } finally {
        await this.engine?.close();
      }
    } finally {
      if (this.timer !== null) clearTimeout(this.timer);
      this.projection.unavailable('stopped');
      try {
        await this.writer.write(this.projection.snapshot());
        await this.content.close();
      } finally {
        this.journal?.submit({
          at: new Date().toISOString(),
          runtime: 'custom',
          kind: 'stopped',
          registration: this.session.registrationGeneration,
        });
        await this.journal?.close();
      }
    }
  }
}
