import type { InteractionReply } from 'stitchkit/agent-executor';
import type { CodexSession } from 'stitchkit/agent-executor/codex';
import { ContentProducer } from '../../../content/producer.ts';
import { codexContextApi, isCodexContextCompletion } from '../../../context/codex.ts';
import { readNativeForkIntent } from '../../../context/fork.ts';
import {
  applyContextCommands,
  NativeContextPump,
  observeContextCompletion,
} from '../../../context/pump.ts';
import { recordDelegationApplied } from '../../../delegation/evidence.ts';
import { nativePolicySkillsAcknowledged } from '../../../policy/codex.ts';
import { applicationPolicyEvidence, verifyApplicationPolicy } from '../../../policy/resolve.ts';
import type { MaterializedPolicy } from '../../../policy/schema.ts';
import { emitRuntimeBoundaries } from '../../../runtime/events.ts';
import { registerRuntimeOwnership } from '../../../runtime/ownership.ts';
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
import { codexAccount } from './account.ts';
import { AdmissionBacklog } from './backlog.ts';
import { applyOwnedCodexInput, applyOwnedCodexInterrupt } from './input.ts';
import { restoreOwnedTurn } from './observer.ts';
import { OwnedCodexProjection } from './projection.ts';
import { type CodexRpcEvent, connectOwnedCodex } from './rpc.ts';
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

function approvalReply(decision: string | null): InteractionReply['reply'] {
  if (decision === 'accept') return { kind: 'approve', scope: 'once' };
  if (decision === 'acceptForSession') return { kind: 'approve', scope: 'session' };
  if (decision === 'cancel') return { kind: 'deny', message: 'cancelled', interrupt: true };
  return { kind: 'deny', message: 'declined', interrupt: false };
}

/** A connection owns its projection and callbacks. A retired connection cannot change a new one. */
export class OwnedCodexConnection {
  private executor: CodexSession | null = null;
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
    private notify: () => void = () => {},
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

  /** Probe that the spawned App Server Unix socket is accepting and initialized before admission. */
  async open(signal: AbortSignal): Promise<void> {
    const probe = await connectOwnedCodex(this.m, this.initial, { signal });
    await probe.close();
  }

  async admit(fresh: boolean, signal: AbortSignal): Promise<Session> {
    const application =
      this.initial.applicationPolicy === undefined
        ? null
        : verifyApplicationPolicy(this.m, 'codex', this.initial.applicationPolicy);
    const fork = fresh ? readNativeForkIntent(this.m, this.initial) : null;
    const { session: executor, response } = await openOwnedThread(
      this.m,
      this.initial,
      fresh,
      fork,
      {
        onNotification: (notification) => {
          if (!this.active) return;
          const event: CodexRpcEvent = { method: notification.method, params: notification.params };
          if (event.method === ACCOUNT_LIMITS_EVENT) {
            // The push is a signal that something moved, never the figure itself. The account read
            // is the one authoritative answer, so the event triggers a re-read instead of becoming
            // data.
            if (this.projection !== null && Date.now() - this.lastLimitsAt >= LIMITS_PUSH_MS)
              void this.readAccountLimits(Date.now()).then(() => this.publish());
            return;
          }
          if (!OBSERVED_EVENTS.has(event.method) && !CODEX_CONTENT_METHODS.has(event.method))
            return;
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
                this.notify();
              }
              if (
                event.method === 'turn/completed' &&
                Date.now() - this.lastLimitsAt >= LIMITS_REFRESH_MS
              )
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
        onServerRequest: (serverRequest) => {
          if (!this.active) return;
          const request = {
            id: serverRequest.requestId,
            method: serverRequest.method,
            params: serverRequest.params,
          };
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
        onDisconnect: (error) => {
          if (!this.active) return;
          this.failure = error;
          this.notify();
          this.projection?.unavailable('disconnected');
          this.publish();
        },
      },
      signal,
    );
    this.executor = executor;
    const currentSelection = readSelection(this.m, this.initial);
    const desiredOptions = currentSelection?.options ?? fork?.source.selection;
    const session = SessionSchema.parse({ ...this.initial, uuid: response.thread.id });
    if (session.delegation !== undefined) {
      await registerRuntimeOwnership(this.m, session, this.providerPid);
    } else if (session.registrationGeneration !== undefined) {
      await registerRuntimeOwnership(this.m, session, this.providerPid).catch((error) => {
        log.warn({
          msg: 'native codex ownership registration skipped',
          name: session.name,
          err: String(error),
        });
      });
    }
    await recordDelegationApplied(this.m, session);
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
    this.liveExecutor();
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
        executor,
        m: this.m,
        session,
        clientId: this.initial.uuid,
        response,
        signal,
        alive: () => this.liveExecutor(),
        started: () => {
          if (application !== null)
            projection.policyEvidence(applicationPolicyEvidence(application, 'applied'));
        },
      });
    // A newly created thread has no historical turn to restore. Its bootstrap is already observed
    // on this connection. Asking the experimental history reader here can race native thread-store
    // materialization (some installed stores refuse list_turns before it is available).
    if (!fresh || fork !== null) await restoreOwnedTurn(executor, projection, session.uuid);
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
      const executor = this.liveExecutor();
      const [account, limits] = await Promise.all([
        this.bounded(executor.readAccount({ refreshToken: false })),
        this.bounded(executor.readRateLimits()),
      ]);
      projection.accountLimits(codexAccount(account), codexPlanLimits(limits, now), now);
    } catch (error) {
      projection.accountLimits(
        null,
        planLimitsReadFailed(projection.snapshot().planLimits, now, String(error)),
        now,
      );
    }
  }

  async refresh(session: Session): Promise<void> {
    const executor = this.liveExecutor();
    const projection = this.projection;
    if (projection === null) throw new Error('Native connection has not been admitted');
    const revision = projection.revision;
    const thread = await readCodexAppThread(executor, session.uuid);
    this.liveExecutor();
    projection.reconcile(thread.status, revision);
    const now = Date.now();
    if (
      now - this.lastLimitsAt >= LIMITS_REFRESH_MS ||
      planLimitsDue(projection.snapshot().planLimits, now)
    )
      void this.readAccountLimits(now).then(() => this.publish());
    await this.writer.write(projection.snapshot());
  }

  activateEvents(session: Session): void {
    this.feedSession = session;
    this.emittedBoundary = this.projection?.snapshot().events.at(-1)?.sequence ?? 0;
  }

  applyContext(session: Session, signal: AbortSignal): void {
    if (this.projection === null) throw new Error('Native connection has not been admitted');
    const generation = this.projection.snapshot().generation;
    this.contextPump.start(signal, async (contextSignal) => {
      const api = codexContextApi(this.m, session, this.liveExecutor());
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
        const executor = this.liveExecutor();
        const reply: InteractionReply['reply'] =
          command.kind === 'approval'
            ? approvalReply(command.decision)
            : {
                kind: 'input',
                value: Object.fromEntries(
                  Object.entries(command.answers ?? {}).map(([id, answers]) => [id, { answers }]),
                ),
              };
        await executor.respond(String(pending.rpcId), reply);
        projection?.submitRequest(command.requestId);
        this.publish();
      },
    });
  }

  /** Start the turn the daemon queued for this session, when nothing is in its way. */
  async applyInput(session: Session): Promise<void> {
    const projection = this.projection;
    if (projection === null) return;
    if (
      await applyOwnedCodexInput(this.m, session, this.liveExecutor(), () => projection.snapshot())
    )
      this.publish();
  }

  /** Stop the turn a caller named, if it is still the one running. */
  async applyInterrupt(session: Session): Promise<void> {
    const projection = this.projection;
    if (projection === null) return;
    await applyOwnedCodexInterrupt(this.m, session, this.liveExecutor(), () =>
      projection.snapshot(),
    );
  }

  async close(reason: string): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.contextPump.close();
    const executor = this.executor;
    this.executor = null;
    if (executor !== null) await executor.close().catch(() => {});
    if (this.projection !== null) {
      this.projection.unavailable(reason);
      await this.writer.write(this.projection.snapshot());
    }
    await this.content?.close();
  }

  private liveExecutor(): CodexSession {
    if (this.failure !== null) throw this.failure;
    if (!this.active || this.executor === null) throw new Error('Native connection is closed');
    return this.executor;
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
