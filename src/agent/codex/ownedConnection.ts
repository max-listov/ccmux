import { SessionSchema } from '../../config/schema.ts';
import {
  CODEX_CONTENT_METHODS,
  observeCodexContent,
  observeCodexRequest,
} from '../../content/codex.ts';
import { ContentProducer } from '../../content/producer.ts';
import { codexContextApi, isCodexContextCompletion } from '../../context/codex.ts';
import { admitNativeFork, readNativeForkIntent } from '../../context/fork.ts';
import {
  applyContextCommands,
  NativeContextPump,
  observeContextCompletion,
} from '../../context/pump.ts';
import { nativePolicySkillsAcknowledged, policySkillInputs } from '../../policy/codex.ts';
import { applicationPolicyEvidence, verifyApplicationPolicy } from '../../policy/resolve.ts';
import type { MaterializedPolicy } from '../../policy/schema.ts';
import {
  codexPlanLimits,
  mergePlanLimits,
  unpublishedPlanLimits,
} from '../../runtime/planLimits.ts';
import { readSelection, seedNativeSelection } from '../../runtime/selection.ts';
import { NativeTurnOptionsSchema } from '../../runtime/selectionSchema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { log } from '../../util/log.ts';
import { codexAppMessagePersisted } from './appPickup.ts';
import {
  CodexAppThreadContextSchema,
  prepareManagedCodexTurn,
  readCodexAppThread,
  startCodexAppTurn,
} from './appServer.ts';
import { codexAccount } from './ownedAccount.ts';
import { clearNativeCommand, readNativeCommand, writeNativeReceipt } from './ownedControl.ts';
import { emitOwnedCodexBoundary } from './ownedEvents.ts';
import { ownedCodexThreadParams } from './ownedLaunch.ts';
import { restoreOwnedTurn } from './ownedObserver.ts';
import { OwnedCodexProjection } from './ownedProjection.ts';
import { connectOwnedCodex } from './ownedRpc.ts';
import { OwnedCodexStatusWriter } from './ownedStatus.ts';
import { rolloutReadiness } from './resume.ts';
import type { CodexAppRpc, CodexRpcEvent, CodexRpcRequest } from './rpc.ts';
import { codexTextInput } from './turnInput.ts';

/**
 * The account's plan windows, pushed by the server without being asked.
 *
 * It carries no thread id — the fact belongs to the account, not to this conversation — so it is
 * handled before the thread-scoped observation and never reaches the projection's event path.
 */
const ACCOUNT_LIMITS_EVENT = 'account/rateLimits/updated';

/** A pull answers "how full is it now"; more often than this is a round trip for a constant. */
const LIMITS_REFRESH_MS = 60_000;

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
  private buffered: CodexRpcEvent[] = [];
  private bufferedRequests: CodexRpcRequest[] = [];
  private bufferedBytes = 0;
  private content: ContentProducer | null = null;
  private contentThreadId: string | null = null;
  private omittedContent = 0;
  private active = true;
  private failure: Error | null = null;
  private feedSession: Session | null = null;
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
          const pushed = (event.params as { rateLimits?: unknown } | null)?.rateLimits;
          if (pushed !== undefined && this.projection !== null) {
            // Merged, not replaced: the push carries whichever limit the last turn spent against,
            // and every window it is silent about is still the only measurement anybody has.
            this.projection.accountLimits(
              null,
              mergePlanLimits(
                this.projection.snapshot().planLimits,
                codexPlanLimits(pushed, Date.now()),
              ),
            );
            this.lastLimitsAt = Date.now();
            this.publish();
          }
          return;
        }
        if (!OBSERVED_EVENTS.has(event.method) && !CODEX_CONTENT_METHODS.has(event.method)) return;
        if (this.projection === null) {
          const size = Buffer.byteLength(JSON.stringify(event));
          while (this.buffered.length >= 128 || this.bufferedBytes + size > 448 * 1024) {
            const index = this.buffered.findIndex(
              (item) => item.method.endsWith('/delta') || item.method.endsWith('/summaryTextDelta'),
            );
            if (index < 0) break;
            const removed = this.buffered.splice(index, 1)[0];
            if (removed) {
              this.bufferedBytes -= Buffer.byteLength(JSON.stringify(removed));
              this.omittedContent++;
            }
          }
          if (this.buffered.length >= 128 || this.bufferedBytes + size > 448 * 1024) {
            if (event.method.endsWith('/delta') || event.method.endsWith('/summaryTextDelta'))
              this.omittedContent++;
            else this.failure = new Error('Native admission event window overflow');
          } else {
            this.buffered.push(event);
            this.bufferedBytes += size;
          }
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
              // The window only moves when a turn spends against it, so this is the moment the
              // answer can have changed — and the server does not always push one.
              void this.readAccountLimits(Date.now()).then(() => this.publish());
            if (OBSERVED_EVENTS.has(event.method) && this.projection.event(event)) {
              this.publish();
              if (this.feedSession !== null && event.method !== 'thread/status/changed') {
                emitOwnedCodexBoundary(this.m, this.feedSession, this.projection.snapshot());
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
          this.bufferedBytes += Buffer.byteLength(JSON.stringify(request));
          if (this.bufferedRequests.length >= 16 || this.bufferedBytes > 512 * 1024)
            this.failure = new Error('Native request admission window overflow');
          else this.bufferedRequests.push(request);
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
    const response =
      fork === null
        ? CodexAppThreadContextSchema.parse(
            await rpc.request(fresh ? 'thread/start' : 'thread/resume', {
              ...ownedCodexThreadParams(this.initial, this.m),
              ...(fresh ? {} : { threadId: this.initial.uuid, excludeTurns: true }),
            }),
          )
        : await admitNativeFork(
            this.m,
            this.initial,
            {
              fork: async (source, nativeSignal) => {
                nativeSignal.throwIfAborted();
                return CodexAppThreadContextSchema.parse(
                  await rpc.request('thread/fork', {
                    ...ownedCodexThreadParams(this.initial, this.m),
                    threadId: source.nativeId,
                    ...(source.turnId === null ? {} : { lastTurnId: source.turnId }),
                    excludeTurns: true,
                    deferGoalContinuation: true,
                  }),
                );
              },
              identity: (result) => result.thread.id,
              resume: async (threadId, nativeSignal) => {
                nativeSignal.throwIfAborted();
                return CodexAppThreadContextSchema.parse(
                  await rpc.request('thread/resume', {
                    ...ownedCodexThreadParams(this.initial, this.m),
                    threadId,
                    excludeTurns: true,
                    deferGoalContinuation: true,
                  }),
                );
              },
            },
            signal,
          );
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
    this.content.buffer.noteOmitted(this.omittedContent);
    // Events were registered before thread/start or resume. Replay before applying the response;
    // a snapshot that raced a newer event must never overwrite that event.
    for (const event of this.buffered) {
      projection.event(event);
      this.observePolicy(event);
      observeCodexContent(this.content.buffer, session.uuid, event);
    }
    this.buffered = [];
    for (const request of this.bufferedRequests) {
      projection.request(request);
      observeCodexRequest(this.content.buffer, session.uuid, request);
    }
    this.bufferedRequests = [];
    this.bufferedBytes = 0;
    this.content.publish();
    projection.reconcile(response.thread.status, 0);
    if (fresh && fork === null) {
      const policy = await prepareManagedCodexTurn(rpc, this.m, session, response);
      const deadline = Date.now() + this.m.codexCorrelationTimeoutMs;
      let turnError: unknown = null;
      try {
        await startCodexAppTurn(
          rpc,
          session.uuid,
          this.initial.uuid,
          codexTextInput(
            'Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.',
          ),
          policy,
        );
        if (application !== null)
          projection.policyEvidence(applicationPolicyEvidence(application, 'applied'));
      } catch (error) {
        turnError = error;
      }
      let rollout = rolloutReadiness(session, this.m);
      while (rollout.status !== 'ready' && Date.now() < deadline) {
        signal.throwIfAborted();
        this.liveRpc();
        await Bun.sleep(50);
        rollout = rolloutReadiness(session, this.m);
      }
      if (rollout.status !== 'ready') {
        throw new Error(
          `Native session rollout metadata did not become readable before admission (${rollout.detail}; turn=${String(turnError)})`,
        );
      }
      if (turnError !== null) {
        // A provider can expose the rollout inode before committing session_meta, then reject the
        // first turn while its own thread store is between those two states. Retry only that named
        // pre-dispatch failure, with the same immutable client id, and first rule out a persisted
        // acceptance after a lost response.
        if (!/thread-store.*(?:rollout is empty|session metadata)/i.test(String(turnError)))
          throw turnError;
        if (!(await codexAppMessagePersisted(this.m, session.uuid, this.initial.uuid))) {
          await startCodexAppTurn(
            rpc,
            session.uuid,
            this.initial.uuid,
            codexTextInput(
              'Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.',
            ),
            policy,
          );
          if (application !== null)
            projection.policyEvidence(applicationPolicyEvidence(application, 'applied'));
        }
      }
    }
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

  /**
   * Ask the account how much of its plan is left.
   *
   * Both answers come from the account, not the thread, so a session that has taken no turn can
   * still say how full the window is — which is the point: an operator learns about exhaustion
   * from a refusal otherwise. A runtime that does not answer publishes the fact that it does not,
   * because "unpublished" and "nothing used" are opposite readings of the same blank space.
   */
  /** A read that never answers is a read that failed; a session is not held open waiting for it. */
  private bounded<T>(request: Promise<T>): Promise<T> {
    return Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Native account read timed out')), 5_000).unref(),
      ),
    ]);
  }

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
    } catch {
      // Enrichment, never a precondition: a session whose account cannot be read still runs, and
      // the previous measurement stays standing rather than being replaced by a zero.
      if (projection.snapshot().planLimits === undefined)
        projection.accountLimits(null, unpublishedPlanLimits(now), now);
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
    // hold up the status a supervisor reconnects to publish.
    if (now - this.lastLimitsAt >= LIMITS_REFRESH_MS)
      void this.readAccountLimits(now).then(() => this.publish());
    await this.writer.write(projection.snapshot());
  }

  activateEvents(session: Session): void {
    this.feedSession = session;
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
    const command = readNativeCommand(this.m, this.initial.name);
    if (command === null) return;
    const projection = this.projection;
    const rpc = this.liveRpc();
    const reject = async (reason: string) => {
      await writeNativeReceipt(this.m, this.initial.name, {
        operationId: command.operationId,
        requestId: command.requestId,
        fingerprint: command.fingerprint,
        outcome: 'rejected',
        reason,
      });
      clearNativeCommand(this.m, this.initial.name);
    };
    if (projection === null || projection.snapshot().generation !== command.generation)
      return reject('projection-generation-mismatch');
    const pending = projection.pendingRequest(command.requestId);
    if (pending === null) return reject('request-is-not-pending');
    if (pending.kind !== command.kind) return reject('request-kind-mismatch');
    let result: unknown;
    if (pending.kind === 'approval') {
      if (command.decision === null || !pending.decisions.includes(command.decision))
        return reject('decision-is-not-available');
      result = { decision: command.decision };
    } else {
      if (command.answers === null) return reject('answers-are-required');
      const expected = pending.questions.map((question) => question.id).sort();
      if (JSON.stringify(Object.keys(command.answers).sort()) !== JSON.stringify(expected))
        return reject('question-id-mismatch');
      result = {
        answers: Object.fromEntries(
          Object.entries(command.answers).map(([id, answers]) => [id, { answers }]),
        ),
      };
    }
    if (rpc.respond === undefined) return reject('native-response-channel-unavailable');
    await rpc.respond(pending.rpcId, result);
    projection.submitRequest(command.requestId);
    this.publish();
    await writeNativeReceipt(this.m, this.initial.name, {
      operationId: command.operationId,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      outcome: 'submitted',
      reason: null,
    });
    clearNativeCommand(this.m, this.initial.name);
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
