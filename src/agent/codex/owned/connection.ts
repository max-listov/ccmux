import { ContentProducer } from '../../../content/producer.ts';
import { codexContextApi, isCodexContextCompletion } from '../../../context/codex.ts';
import { readNativeForkIntent } from '../../../context/fork.ts';
import {
  applyContextCommands,
  NativeContextPump,
  observeContextCompletion,
} from '../../../context/pump.ts';
import { nativePolicySkillsAcknowledged, policySkillInputs } from '../../../policy/codex.ts';
import { applicationPolicyEvidence, verifyApplicationPolicy } from '../../../policy/resolve.ts';
import type { MaterializedPolicy } from '../../../policy/schema.ts';
import { emitRuntimeBoundaries } from '../../../runtime/events.ts';
import {
  codexPlanLimits,
  planLimitsDue,
  planLimitsReadFailed,
} from '../../../runtime/planLimits.ts';
import { answerNativeCommand } from '../../../runtime/response.ts';
import { readSelection, seedNativeSelection } from '../../../runtime/selection.ts';
import { NativeTurnOptionsSchema } from '../../../runtime/selectionSchema.ts';
import { SessionSchema } from '../../../session/schema.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { log } from '../../../util/log.ts';
import { readCodexAppThread } from '../appServer.ts';
import { CODEX_CONTENT_METHODS, observeCodexContent, observeCodexRequest } from '../content.ts';
import type { CodexAppRpc, CodexRpcEvent } from '../rpc.ts';
import { codexAccount } from './account.ts';
import { AdmissionBacklog } from './backlog.ts';
import { applyOwnedCodexInput, applyOwnedCodexInterrupt } from './input.ts';
import { restoreOwnedTurn } from './observer.ts';
import { OwnedCodexProjection } from './projection.ts';
import { connectOwnedCodex } from './rpc.ts';
import { OwnedCodexStatusWriter } from './status.ts';
import { bootstrapOwnedThread, openOwnedThread } from './thread.ts';

/**
 * The account's plan windows, pushed by the server without being asked.
 *
 * It carries no thread id — the fact belongs to the account, not to this conversation — so it is
 * handled before the thread-scoped observation and never reaches the projection's event path.
 */
const ACCOUNT_LIMITS_EVENT = 'account/rateLimits/updated';

/** A pull answers "how full is it now"; more often than this is a round trip for a constant. */
const LIMITS_REFRESH_MS = 60_000;

/** A push says something moved, and re-reading on every one of them would be a round trip per turn. */
const LIMITS_PUSH_MS = 5_000;

const OBSERVED_EVENTS = new Set([
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'thread/tokenUsage/updated',
  'serverRequest/resolved',
  'thread/settings/updated',
  'model/rerouted',
]);

/** A connection owns its projection and callbacks. A retired connection cannot change a new one. */
export class OwnedCodexConnection {
  private rpc: CodexAppRpc | null = null;
  private projection: OwnedCodexProjection | null = null;
  private backlog = new AdmissionBacklog();
  private content: ContentProducer | null = null;
  private contentThreadId: string | null = null;
  private active = true;
  private failure: Error | null = null;
  private feedSession: Session | null = null;
  /** Highest boundary sequence already announced to the feed — the ring is re-read on every publish. */
  private emittedBoundary = 0;
  private applicationPolicy: MaterializedPolicy | null = null;
  private lastLimitsAt = 0;
  private contextCompletionSeen = 0;
  private contextCompletionApplied = 0;
  private contextPump: NativeContextPump;
  readonly writer: OwnedCodexStatusWriter;

  constructor(
    private m: MachineConfig,
    private initial: Session,
    private providerPid: number,
  ) {
    this.writer = new OwnedCodexStatusWriter(m, initial.name);
    this.contextPump = new NativeContextPump((error) =>
      log.error({
        msg: 'native context observation failed',
        name: initial.name,
        error: String(error),
      }),
    );
  }

  async open(signal: AbortSignal): Promise<void> {
    this.rpc = await connectOwnedCodex(this.m, this.initial, {
      signal,
      onEvent: (event) => {
        if (!this.active) return;
        if (event.method === ACCOUNT_LIMITS_EVENT) {
          // The push is a signal that something moved, never the figure itself. Measured on a live
          // account: it carries the limits of the model the turn ran on while labelling them with
          // the account-wide limit id, so publishing it replaced the account's week (91%) with a
          // model's (7%) under the same name. The account read is the one authoritative answer, so
          // the event triggers a re-read instead of becoming data.
          if (this.projection !== null && Date.now() - this.lastLimitsAt >= LIMITS_PUSH_MS)
            void this.readAccountLimits(Date.now()).then(() => this.publish());
          return;
        }
        if (!OBSERVED_EVENTS.has(event.method) && !CODEX_CONTENT_METHODS.has(event.method)) return;
        if (this.projection === null) {
          this.failure ??= this.backlog.event(event);
        } else {
          try {
            this.observePolicy(event);
            if (this.content !== null && this.contentThreadId !== null) {
              observeCodexContent(this.content.buffer, this.contentThreadId, event);
              this.content.publish();
            }
            if (
              this.feedSession !== null &&
              isCodexContextCompletion(event, this.feedSession.uuid)
            ) {
              this.contextCompletionSeen++;
            }
            if (
              event.method === 'turn/completed' &&
              Date.now() - this.lastLimitsAt >= LIMITS_REFRESH_MS
            )
              // A turn is one of the moments the answer can have changed — the other is the clock,
              // which the periodic refresh covers. The server does not always push either.
              void this.readAccountLimits(Date.now()).then(() => this.publish());
            if (OBSERVED_EVENTS.has(event.method) && this.projection.event(event)) {
              this.publish();
              if (this.feedSession !== null && event.method !== 'thread/status/changed') {
                this.emittedBoundary = emitRuntimeBoundaries(
                  this.m,
                  this.feedSession,
                  this.projection.snapshot(),
                  this.emittedBoundary,
                );
              }
            }
          } catch (error) {
            this.failure = new Error('Native content observation failed', { cause: error });
          }
        }
      },
      onRequest: (request) => {
        if (!this.active) return;
        if (this.projection === null) {
          this.failure ??= this.backlog.request(request);
        } else if (this.projection.request(request)) {
          if (this.content !== null && this.contentThreadId !== null) {
            observeCodexRequest(this.content.buffer, this.contentThreadId, request);
            this.content.publish();
          }
          this.publish();
        }
      },
      onClose: (error) => {
        if (!this.active) return;
        this.failure = error;
        this.projection?.unavailable('disconnected');
        this.publish();
      },
    });
  }

  async admit(fresh: boolean, signal: AbortSignal): Promise<Session> {
    const rpc = this.liveRpc();
    const application =
      this.initial.applicationPolicy === undefined
        ? null
        : verifyApplicationPolicy(this.m, 'codex', this.initial.applicationPolicy);
    if (application?.runtime === 'codex' && application.skills.length > 0)
      policySkillInputs(
        application,
        this.initial.dir,
        await rpc.request('skills/list', { cwds: [this.initial.dir], forceReload: true }),
      );
    const fork = fresh ? readNativeForkIntent(this.m, this.initial) : null;
    const response = await openOwnedThread(rpc, this.m, this.initial, fresh, fork, signal);
    if (!fresh && response.thread.id !== this.initial.uuid)
      throw new Error('Native resume returned a different thread identity');
    const currentSelection = readSelection(this.m, this.initial);
    const desiredOptions = currentSelection?.options ?? fork?.source.selection;
    const expectedModel = currentSelection?.options.model ?? this.initial.modelSelection;
    if (
      expectedModel !== undefined &&
      (response.model !== expectedModel.model || response.modelProvider !== expectedModel.provider)
    )
      throw new Error('Native admission changed the selected provider or model');
    const session = SessionSchema.parse({ ...this.initial, uuid: response.thread.id });
    const projection = new OwnedCodexProjection(this.m, session, this.providerPid);
    if (response.model !== undefined && response.modelProvider !== undefined)
      projection.selectionEvidence({
        model: { model: response.model, provider: response.modelProvider },
        options: null,
        source: 'admission',
        turnId: null,
      });
    this.applicationPolicy = application;
    if (application?.runtime === 'codex' && application.skills.length === 0)
      projection.policyEvidence(applicationPolicyEvidence(application, 'applied'));
    this.content = new ContentProducer(this.m, session, projection.snapshot().generation);
    this.contentThreadId = session.uuid;
    // Live status makes this identity readable. Commit its initial content before enabling
    // status callbacks; native events remain buffered while the baseline write is pending.
    await this.content.writer.flushPending();
    signal.throwIfAborted();
    this.liveRpc();
    this.projection = projection;
    this.content.buffer.noteOmitted(this.backlog.omitted);
    // Events were registered before thread/start or resume. Replay before applying the response;
    // a snapshot that raced a newer event must never overwrite that event.
    for (const event of this.backlog.events) {
      projection.event(event);
      this.observePolicy(event);
      observeCodexContent(this.content.buffer, session.uuid, event);
    }
    for (const request of this.backlog.requests) {
      projection.request(request);
      observeCodexRequest(this.content.buffer, session.uuid, request);
    }
    this.backlog.clear();
    this.content.publish();
    projection.reconcile(response.thread.status, 0);
    if (fresh && fork === null)
      await bootstrapOwnedThread({
        rpc,
        m: this.m,
        session,
        clientId: this.initial.uuid,
        response,
        signal,
        alive: () => this.liveRpc(),
        started: () => {
          if (application !== null)
            projection.policyEvidence(applicationPolicyEvidence(application, 'applied'));
        },
      });
    // A newly created thread has no historical turn to restore. Its bootstrap is already observed
    // on this connection. Asking the experimental history reader here can race native thread-store
    // materialization (some installed stores refuse list_turns before it is available).
    if (!fresh || fork !== null) await restoreOwnedTurn(rpc, projection, session.uuid);
    await this.refresh(session);
    await seedNativeSelection(
      this.m,
      session,
      NativeTurnOptionsSchema.parse({
        runtime: 'codex',
        model: { provider: response.modelProvider, model: response.model },
        mode:
          desiredOptions?.runtime === 'codex'
            ? desiredOptions.mode
            : (session.launchRecipe?.collaborationMode ?? 'default'),
        ...(response.reasoningEffort == null ? {} : { effort: response.reasoningEffort }),
      }),
    );
    return session;
  }

  /** A read that never answers is a read that failed; a session is not held open waiting for it. */
  private bounded<T>(request: Promise<T>): Promise<T> {
    return Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Native account read timed out')), 5_000).unref(),
      ),
    ]);
  }

  /**
   * Ask the account how much of its plan is left.
   *
   * Both answers come from the account, not the thread, so a session that has taken no turn can
   * still say how full the window is — which is the point: an operator learns about exhaustion
   * from a refusal otherwise. A runtime that does not answer publishes the fact that it does not,
   * because "unpublished" and "nothing used" are opposite readings of the same blank space.
   */
  private async readAccountLimits(now: number): Promise<void> {
    const projection = this.projection;
    if (projection === null) return;
    this.lastLimitsAt = now;
    try {
      const [account, limits] = await Promise.all([
        this.bounded(this.liveRpc().request('account/read', { refreshToken: false })),
        this.bounded(this.liveRpc().request('account/rateLimits/read', {})),
      ]);
      projection.accountLimits(codexAccount(account), codexPlanLimits(limits, now), now);
    } catch (error) {
      // Enrichment, never a precondition: a session whose account cannot be read still runs, and
      // the previous measurement stays standing rather than being replaced by a zero. It does not
      // stand SILENTLY, though — an unrefreshed sample and an unspent window look identical from
      // outside, and only one of them is a reason to go and look.
      projection.accountLimits(
        null,
        planLimitsReadFailed(projection.snapshot().planLimits, now, String(error)),
        now,
      );
    }
  }

  async refresh(session: Session): Promise<void> {
    const rpc = this.liveRpc();
    const projection = this.projection;
    if (projection === null) throw new Error('Native connection has not been admitted');
    const revision = projection.revision;
    const thread = await readCodexAppThread(rpc, session.uuid);
    this.liveRpc();
    projection.reconcile(thread.status, revision);
    const now = Date.now();
    // Never awaited: how full the plan is is enrichment, and a runtime slow to answer it must not
    // hold up the status a supervisor reconnects to publish. Due, not merely old: a window that has
    // reached its own `resetsAt` is describing an interval that has ended, and the throttle below
    // would otherwise serve it for another minute as if it were current.
    if (
      now - this.lastLimitsAt >= LIMITS_REFRESH_MS ||
      planLimitsDue(projection.snapshot().planLimits, now)
    )
      void this.readAccountLimits(now).then(() => this.publish());
    await this.writer.write(projection.snapshot());
  }

  activateEvents(session: Session): void {
    this.feedSession = session;
    // The cursor starts at what has ALREADY happened, so activation announces nothing about the past.
    // A turn that was running at admission is state, not news: reconciliation establishes where the
    // session is, and replaying its boundary would tell a reader that work began the moment someone
    // started listening.
    this.emittedBoundary = this.projection?.snapshot().events.at(-1)?.sequence ?? 0;
  }

  applyContext(session: Session, signal: AbortSignal): void {
    if (this.projection === null) throw new Error('Native connection has not been admitted');
    const generation = this.projection.snapshot().generation;
    this.contextPump.start(signal, async (contextSignal) => {
      const api = codexContextApi(this.m, session, this.liveRpc());
      const completion = this.contextCompletionSeen;
      if (completion !== this.contextCompletionApplied) {
        const marker = await api.compactionMarker(contextSignal);
        if (marker === null) throw new Error('Completed native context marker is unavailable');
        await observeContextCompletion(this.m, session, generation, marker, () =>
          this.publishContextBoundary(),
        );
        this.contextCompletionApplied = completion;
      }
      await applyContextCommands(this.m, session, generation, api, contextSignal, () =>
        this.publishContextBoundary(),
      );
    });
  }

  private async publishContextBoundary(): Promise<void> {
    if (this.content === null) throw new Error('Native context content publication is unavailable');
    this.content.buffer.resetContext();
    this.content.publish();
    await this.content.writer.flushPending();
  }

  async applyControlResponse(): Promise<void> {
    const projection = this.projection;
    await answerNativeCommand(this.m, this.initial.name, {
      generation: projection?.snapshot().generation,
      pending: (requestId) => projection?.pendingRequest(requestId) ?? null,
      submit: async (command, pending) => {
        const rpc = this.liveRpc();
        if (rpc.respond === undefined) throw new Error('Native response channel is unavailable');
        await rpc.respond(
          pending.rpcId,
          command.kind === 'approval'
            ? { decision: command.decision }
            : {
                answers: Object.fromEntries(
                  Object.entries(command.answers ?? {}).map(([id, answers]) => [id, { answers }]),
                ),
              },
        );
        projection?.submitRequest(command.requestId);
        this.publish();
      },
    });
  }

  /** Start the turn the daemon queued for this session, when nothing is in its way. */
  async applyInput(session: Session): Promise<void> {
    const projection = this.projection;
    if (projection === null) return;
    if (await applyOwnedCodexInput(this.m, session, this.liveRpc(), () => projection.snapshot()))
      this.publish();
  }

  /** Stop the turn a caller named, if it is still the one running. */
  async applyInterrupt(session: Session): Promise<void> {
    const projection = this.projection;
    if (projection === null) return;
    await applyOwnedCodexInterrupt(this.m, session, this.liveRpc(), () => projection.snapshot());
  }

  async close(reason: string): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.contextPump.close();
    this.rpc?.close();
    this.rpc = null;
    if (this.projection !== null) {
      this.projection.unavailable(reason);
      await this.writer.write(this.projection.snapshot());
    }
    await this.content?.close();
  }

  private liveRpc(): CodexAppRpc {
    if (this.failure !== null) throw this.failure;
    if (!this.active || this.rpc === null) throw new Error('Native connection is closed');
    return this.rpc;
  }

  private observePolicy(event: CodexRpcEvent): void {
    if (
      (event.method === 'item/started' || event.method === 'item/completed') &&
      this.applicationPolicy !== null &&
      this.projection !== null &&
      nativePolicySkillsAcknowledged(
        this.applicationPolicy,
        this.projection.snapshot().threadId,
        event.params,
      )
    ) {
      verifyApplicationPolicy(this.m, 'codex', this.applicationPolicy.metadata);
      this.projection.policyEvidence(applicationPolicyEvidence(this.applicationPolicy, 'applied'));
    }
  }

  private publish(): void {
    if (this.projection === null) return;
    void this.writer.write(this.projection.snapshot()).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      log.error({
        msg: 'native state publication failed',
        name: this.initial.name,
        error: String(error),
      });
    });
  }
}
